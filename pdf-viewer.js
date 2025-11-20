// PDF Viewer with complete ListCore integration and PDF.js rendering

(function(){
  'use strict';
  // unique id for this window/tab to avoid processing our own BroadcastChannel messages
  const WINDOW_ID = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : ('win-' + Math.random().toString(36).slice(2));

  // PDF.js 관련 변수
  let pdfDoc = null;
  let currentPage = 1;
  let totalPages = 0;
  // 기본 배율을 200%로 설정
  let currentScale = 2.0;
  let canvas = null;
  let ctx = null;

  // 전역 상태 (메인 페이지와 동일한 구조)
  window.state = {
    userLists: []
  };

  // Operation queue for list operations (from main page)
  let _opQueue = [];
  let _opRunning = false;
  
  function enqueueOperation(fn){
    console.log('🔥 PDF VIEWER ENQUEUE: Adding operation to queue');
    return new Promise((res, rej)=>{
      _opQueue.push({ fn, res, rej });
      console.log('🔥 PDF VIEWER ENQUEUE: Queue length =', _opQueue.length);
      setTimeout(processOpQueue, 0);
    });
  }
  
  async function processOpQueue(){
    console.log('🔥 PDF VIEWER PROCESS QUEUE: Called, running =', _opRunning, 'length =', _opQueue.length);
    if(_opRunning) return;
    const item = _opQueue.shift();
    if(!item) return;
    
    _opRunning = true;
    try{
      const res = await item.fn();
      item.res(res);
    }catch(e){
      console.warn('PDF VIEWER: operation failed', e);
      item.rej(e);
    }finally{
      _opRunning = false;
      if(_opQueue.length > 0) setTimeout(processOpQueue, 0);
    }
  }

  // Expose a minimal runtime API for external AI module
  // so AI code can operate in a separate file (`pdf-ai.js`).
  try {
    window.PDFViewer = window.PDFViewer || {};
    window.PDFViewer.getPdfDoc = () => pdfDoc;
  } catch (e) {
    console.warn('PDF Viewer: failed to expose PDFViewer API', e);
  }

  // Helper functions
  function escapeHtml(unsafe) {
    return unsafe
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // make escapeHtml available to external modules (pdf-ai.js)
  try { window.escapeHtml = escapeHtml; } catch (e) { /* ignore */ }

  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }

  // 이동 함수들 (메인 페이지에서 복사)
  function findNode(lists, id) {
    for (const list of lists) {
      if (list.id === id) return list;
      if (list.children) {
        const found = findNode(list.children, id);
        if (found) return found;
      }
    }
    return null;
  }
  
  function removeNode(lists, id) {
    for (let i = 0; i < lists.length; i++) {
      if (lists[i].id === id) {
        const removed = lists.splice(i, 1)[0];
        return removed;
      }
      if (lists[i].children) {
        const removed = removeNode(lists[i].children, id);
        if (removed) return removed;
      }
    }
    return null;
  }

  async function moveNode(nodeId, targetParentId) {
    console.log('🔥 PDF VIEWER MOVE NODE:', nodeId, 'to parent:', targetParentId);
    const node = removeNode(window.state.userLists, nodeId);
    if (!node) {
      console.error('Node not found:', nodeId);
      return;
    }

    if (targetParentId === '') {
      // 루트 레벨로 이동
      window.state.userLists.push(node);
    } else {
      // 특정 부모로 이동
      const parent = findNode(window.state.userLists, targetParentId);
      if (parent) {
        if (!parent.children) parent.children = [];
        parent.children.push(node);
      } else {
        console.error('Target parent not found:', targetParentId);
        window.state.userLists.push(node); // fallback to root
      }
    }
    console.log('✅ PDF VIEWER MOVE NODE: Complete');
  }

  async function moveNodeToIndex(nodeId, targetParentId, targetIndex) {
    console.log('🔥 PDF VIEWER MOVE NODE TO INDEX:', nodeId, 'to parent:', targetParentId, 'index:', targetIndex);
    const node = removeNode(window.state.userLists, nodeId);
    if (!node) {
      console.error('Node not found:', nodeId);
      return;
    }

    let targetArray;
    if (targetParentId === '') {
      targetArray = window.state.userLists;
    } else {
      const parent = findNode(window.state.userLists, targetParentId);
      if (parent) {
        if (!parent.children) parent.children = [];
        targetArray = parent.children;
      } else {
        console.error('Target parent not found:', targetParentId);
        window.state.userLists.push(node);
        return;
      }
    }

    // 지정된 인덱스에 삽입
    if (targetIndex >= 0 && targetIndex <= targetArray.length) {
      targetArray.splice(targetIndex, 0, node);
    } else {
      targetArray.push(node);
    }
    console.log('✅ PDF VIEWER MOVE NODE TO INDEX: Complete');
  }

  // PDF 뷰어에서 PDF 노드 추가 (메인 페이지 로직 참고)
  async function insertPdfNodeInViewer(parentId, file) {
    if (!file) throw new Error('파일이 없습니다');
    
    console.log('🔥 PDF VIEWER: PDF 노드 추가 시작:', file.name, 'to parent:', parentId);
    
    const fileId = crypto.randomUUID();
    
    // 파일 시그니처 생성 (중복 검사용)
    let fileSignature = null;
    try {
      fileSignature = await hashBlob(file);
    } catch (e) {
      console.warn('PDF 뷰어: 파일 해시 생성 실패:', e);
    }
    
    // IndexedDB에 파일 저장
    try {
      await dbPutFile(fileId, file);
      console.log('✅ PDF 뷰어: IndexedDB에 파일 저장 완료');
    } catch (e) {
      console.warn('PDF 뷰어: IndexedDB 파일 저장 실패:', e);
    }
    
    // PDF 노드 생성
    const pdfNode = {
      id: crypto.randomUUID(),
      name: file.name || '문서.pdf',
      fileId,
      fileSignature: fileSignature || null,
      type: 'pdf',
      children: []
    };
    
    console.log('🔥 PDF VIEWER: 생성된 PDF 노드:', pdfNode);
    
    // 중복 검사
    if (pdfNode.fileSignature) {
      const existing = findNodeByFileSignature(window.state.userLists, pdfNode.fileSignature);
      if (existing) {
        console.warn('PDF 뷰어: 이미 동일한 문서가 존재함');
        showToast('이미 동일한 문서가 목록에 있습니다.', { variant: 'warn' });
        return;
      }
    }
    
    // 부모 찾기 및 노드 추가
    if (parentId === '') {
      // 루트에 추가
      window.state.userLists.push(pdfNode);
    } else {
      // 특정 부모에 추가
      const parent = findNode(window.state.userLists, parentId);
      if (parent) {
        if (!parent.children) parent.children = [];
        parent.children.push(pdfNode);
      } else {
        console.error('PDF 뷰어: 부모 노드를 찾을 수 없음:', parentId);
        window.state.userLists.push(pdfNode); // fallback to root
      }
    }
    
    // ListCore를 통한 저장
    window.ListCore.state.lists = window.state.userLists;
    await window.ListCore.saveChanges(window.state.userLists);
    
  // BroadcastChannel로 다른 페이지에 알림 (include sender id to avoid echo)
  try{ const bc = new BroadcastChannel('paperscout-sync'); bc.postMessage({ type: 'userLists-updated', sender: WINDOW_ID }); bc.close(); }catch(e){ console.warn('BroadcastChannel send failed', e); }
    
    console.log('✅ PDF VIEWER: PDF 노드 추가 완료, 사이드바 재렌더링');
    await renderSidebar();
    
    showToast(`"${file.name}" 파일이 목록에 추가되었습니다.`, { variant: 'success' });
  }

  // 필수 헬퍼 함수들 (메인 페이지에서 가져옴)
  async function hashBlob(blob) {
    const arrayBuffer = await blob.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-1', arrayBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }
  
  async function dbPutFile(fileId, blob) {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('paperscout', 2);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    
    const transaction = db.transaction(['files'], 'readwrite');
    const store = transaction.objectStore('files');
    
    await new Promise((resolve, reject) => {
      const request = store.put({ blob }, fileId);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }
  
  function findNodeByFileSignature(lists, signature) {
    if (!signature) return null;
    for (const list of lists) {
      if (list.fileSignature === signature) return list;
      if (list.children) {
        const found = findNodeByFileSignature(list.children, signature);
        if (found) return found;
      }
    }
    return null;
  }
  
  function showToast(message, options = {}) {
    // 간단한 토스트 알림 (메인 페이지와 동일)
    console.log(`🔔 ${options.variant || 'info'}: ${message}`);
    
    // DOM에 토스트 요소 생성
    let container = document.getElementById('ps-toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'ps-toast-container';
      container.style.cssText = 'position: fixed; top: 20px; right: 20px; z-index: 10000;';
      document.body.appendChild(container);
    }
    
    const toast = document.createElement('div');
    toast.style.cssText = `
      background: ${options.variant === 'warn' ? '#ff9800' : options.variant === 'success' ? '#4caf50' : '#2196f3'};
      color: white;
      padding: 12px 20px;
      margin-bottom: 10px;
      border-radius: 4px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
      max-width: 300px;
    `;
    toast.textContent = message;
    
    const closeBtn = document.createElement('button');
    closeBtn.innerHTML = '✕';
    closeBtn.style.cssText = 'background: none; border: none; color: white; margin-left: 10px; cursor: pointer;';
    closeBtn.addEventListener('click', () => toast.remove());
    toast.appendChild(closeBtn);
    
    container.appendChild(toast);
    
    // 자동 제거
    setTimeout(() => toast.remove(), 3500);
  }

  // 파일 업로드 시 대상 목록 결정
  function getSelectedListForUpload() {
    // 현재 활성화된 (선택된) 목록 찾기
    const activeListItem = document.querySelector('.user-list-item.active, .user-list-item.selected');
    if (activeListItem) {
      const listId = activeListItem.getAttribute('data-id');
      const list = findNode(window.state.userLists, listId);
      
      // PDF가 아닌 폴더인 경우에만 해당 목록에 추가
      if (list && list.type !== 'pdf') {
        console.log('🎯 PDF 뷰어: 선택된 목록에 파일 추가:', list.name);
        return listId;
      }
    }
    
    // 기본값: 루트에 추가
    console.log('🎯 PDF 뷰어: 루트에 파일 추가');
    return '';
  }

  // 사이드바 렌더링 함수
  async function renderSidebar() {
    try {
      console.log('🔥 PDF VIEWER RENDER SIDEBAR: Starting render...');
      console.log('🔍 Current state.userLists:', window.state?.userLists ? window.state.userLists.length : 'null/undefined');
      console.log('🔍 state.userLists structure:', JSON.stringify(window.state.userLists, null, 2));
      
      const ul = document.getElementById('userLists');
      if (!ul) {
        console.error('❌ PDF VIEWER RENDER SIDEBAR: userLists element not found!');
        return;
      }
      
      ul.innerHTML = "";
      
      const build = (lists, container) => {
        for (const list of lists) {
          const li = document.createElement('li');
          li.className = 'user-list-item';
          // PDF 노드 특별 표시
          if (list.type === 'pdf') li.classList.add('user-list-item--pdf');
          li.dataset.id = list.id;
          if (list.fileId) li.dataset.fileId = list.fileId;
          
          // 드래그 가능하게 설정
          li.draggable = true;
          
          const actions = document.createElement('div');
          actions.className = 'user-list__actions';
          
          // PDF 노드와 일반 목록에 따라 다른 액션
          if (list.type === 'pdf') {
            actions.innerHTML = `
              <button class="btn btn--sm btn--ghost js-delete" type="button" aria-label="삭제">✕</button>
            `;
          } else {
            actions.innerHTML = `
              <button class="btn btn--sm btn--ghost js-add-child" type="button" aria-label="하위 추가">＋</button>
              <button class="btn btn--sm btn--ghost js-add-pdf" type="button" aria-label="PDF 추가">📎</button>
              <button class="btn btn--sm btn--ghost js-delete" type="button" aria-label="삭제">✕</button>
            `;
          }
          
          // 헤더 컨테이너 생성 (제목과 액션을 한 줄에)
          const header = document.createElement('div');
          header.className = 'user-list-item__header';
          header.innerHTML = `<span class="user-list__title">${escapeHtml(list.name)}</span>`;
          header.appendChild(actions);
          li.appendChild(header);
          container.appendChild(li);
          
          // 드래그 이벤트 핸들러
          li.addEventListener('dragstart', (e) => {
            console.log('🔥 PDF VIEWER: dragstart event on:', list.name, list.id);
            e.stopPropagation(); // 이벤트 버블링 방지
            e.dataTransfer.setData('text/plain', list.id);
            e.dataTransfer.effectAllowed = 'move';
            li.classList.add('dragging');
          });
          
          li.addEventListener('dragend', (e) => {
            e.stopPropagation(); // 이벤트 버블링 방지
            li.classList.remove('dragging');
          });
          
          // 드롭존 이벤트 핸들러
          li.addEventListener('dragover', (e) => {
            console.log('🔥 PDF VIEWER: dragover event on:', list.name, list.id, 'type:', list.type);
            e.stopPropagation(); // 이벤트 버블링 방지
            if (list.type !== 'pdf') { // PDF는 드롭 대상이 될 수 없음
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              li.classList.add('drag-over');
            }
          });
          
          li.addEventListener('dragleave', (e) => {
            e.stopPropagation(); // 이벤트 버블링 방지
            if (!li.contains(e.relatedTarget)) {
              li.classList.remove('drag-over');
            }
          });
          
          li.addEventListener('drop', async (e) => {
            console.log('🔥 PDF VIEWER: drop event on:', list.name, list.id);
            e.preventDefault();
            e.stopPropagation(); // 이벤트 버블링 방지
            li.classList.remove('drag-over');
            
            if (list.type === 'pdf') return; // PDF는 드롭 대상이 될 수 없음
            
            // 파일 드롭 확인
            const files = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length ? Array.from(e.dataTransfer.files) : [];
            if (files.length > 0) {
              console.log('🔥 PDF VIEWER: 파일 드롭 감지:', files.map(f => ({ name: f.name, type: f.type, size: f.size })));
              
              await enqueueOperation(async () => {
                for (const file of files) {
                  console.log('🔥 PDF VIEWER: 파일 처리 중:', file.name, file.type);
                  if (file.type !== 'application/pdf') {
                    console.warn('PDF 뷰어: PDF가 아닌 파일 건너뜀:', file.name, file.type);
                    continue;
                  }
                  
                  try {
                    await insertPdfNodeInViewer(list.id, file);
                  } catch (err) {
                    console.error('PDF 뷰어: 파일 추가 실패:', file.name, err);
                  }
                }
              });
              return;
            }
            
            // 목록 이동 처리
            const draggedId = e.dataTransfer.getData('text/plain');
            console.log('🔥 PDF VIEWER: dragged node ID:', draggedId, 'target parent:', list.id);
            
            if (draggedId && draggedId !== list.id) {
              await enqueueOperation(async () => {
                console.log('🔥 PDF VIEWER: 목록 이동 시작 - 드래그된 노드:', draggedId, '-> 대상 부모:', list.id);
                
                // ListCore 상태 동기화
                window.ListCore.state.lists = window.state.userLists;
                await moveNode(draggedId, list.id);
                
                // ListCore를 통한 저장
                window.ListCore.state.lists = window.state.userLists;
                await window.ListCore.saveChanges(window.state.userLists);
                
                // BroadcastChannel로 다른 페이지에 알림 (include sender id)
                try{ const bc = new BroadcastChannel('paperscout-sync'); bc.postMessage({ type: 'userLists-updated', sender: WINDOW_ID }); bc.close(); }catch(e){ console.warn('BroadcastChannel send failed', e); }
                
                console.log('🔥 PDF VIEWER: 목록 이동 완료, 사이드바 재렌더링');
                await renderSidebar();
              });
            }
          });
          
          // 자식 목록 처리
          if (list.children && list.children.length > 0) {
            const childUl = document.createElement('ul');
            childUl.className = 'user-lists user-lists--nested';
            li.appendChild(childUl);
            build(list.children, childUl);
          }
        }
      };
      
      if (window.state.userLists && window.state.userLists.length > 0) {
        build(window.state.userLists, ul);
        console.log('✅ PDF VIEWER RENDER SIDEBAR: Rendered', window.state.userLists.length, 'lists');
      } else {
        ul.innerHTML = '<li class="empty-state">목록이 없습니다</li>';
        console.log('📝 PDF VIEWER RENDER SIDEBAR: No lists to display');
      }
    } catch (err) {
      console.error('❌ PDF VIEWER RENDER SIDEBAR: Error:', err);
    }
  }

  // 목록 추가 함수
  async function addNewList() {
    const input = document.getElementById('newListName');
    if (!input) return;
    
    const name = input.value.trim();
    if (!name) return;
    
    await enqueueOperation(async () => {
      // ListCore를 통한 추가
      const newList = await window.ListCore.addList(name);
      
      // 상태 동기화
      window.state.userLists = JSON.parse(JSON.stringify(window.ListCore.state.lists || []));
      
                // BroadcastChannel로 다른 페이지에 알림 (include sender id)
                try{ const bc = new BroadcastChannel('paperscout-sync'); bc.postMessage({ type: 'userLists-updated', sender: WINDOW_ID }); bc.close(); }catch(e){ console.warn('BroadcastChannel send failed', e); }
      
      await renderSidebar();
      input.value = '';
      
      console.log('✅ PDF 뷰어: 새 목록 추가됨:', name);
    });
  }

  // 목록 삭제 함수
  async function handleDeleteList(listId) {
    if (!listId) return;
    
    await enqueueOperation(async () => {
      // ListCore를 통한 삭제
      await window.ListCore.deleteList(listId);
      
      // 상태 동기화
      window.state.userLists = JSON.parse(JSON.stringify(window.ListCore.state.lists || []));
      
      // BroadcastChannel로 다른 페이지에 알림
      const bc = new BroadcastChannel('paperscout-sync');
  try{ bc.postMessage({ type: 'userLists-updated', sender: WINDOW_ID }); }catch(e){ console.warn('BroadcastChannel send failed', e); }
      
      await renderSidebar();
      
      console.log('✅ PDF 뷰어: 목록 삭제됨:', listId);
    });
  }

  // 사이드바 클릭 이벤트 핸들러
  // 파일 업로드 핸들러 함수
  async function handleFileUpload(file, targetListId) {
    console.log('🔥 PDF 뷰어: 파일 업로드 시작:', file.name, '대상 목록:', targetListId);
    
    try {
      await insertPdfNodeInViewer(targetListId, file);
      console.log('✅ PDF 뷰어: 파일 업로드 성공:', file.name);
      showToast(`파일 업로드 성공: ${file.name}`, 'success');
    } catch (error) {
      console.error('❌ PDF 뷰어: 파일 업로드 실패:', error);
      showToast(`파일 업로드 실패: ${file.name}`, 'error');
      throw error;
    }
  }

  async function handleListClick(e) {
    const target = e.target;
    const listItem = target.closest('.user-list-item');
    if (!listItem) return;
    
    const listId = listItem.dataset.id;
    
    if (target.classList.contains('js-delete')) {
      e.preventDefault();
      e.stopPropagation();
      if (confirm('이 목록을 삭제하시겠습니까?')) {
        await handleDeleteList(listId);
      }
    } else if (target.classList.contains('js-add-child')) {
      e.preventDefault();
      e.stopPropagation();
      const name = prompt('하위 목록 이름을 입력하세요:');
      if (name && name.trim()) {
        await enqueueOperation(async () => {
          // ListCore 상태 동기화
          window.ListCore.state.lists = window.state.userLists;
          
          const newList = {
            id: generateId(),
            name: name.trim(),
            children: []
          };
          
          const parent = findNode(window.state.userLists, listId);
          if (parent) {
            if (!parent.children) parent.children = [];
            parent.children.push(newList);
            
            // ListCore를 통한 저장
            window.ListCore.state.lists = window.state.userLists;
            await window.ListCore.saveChanges(window.state.userLists);
            
            // BroadcastChannel로 다른 페이지에 알림
            const bc = new BroadcastChannel('paperscout-sync');
                try{ bc.postMessage({ type: 'userLists-updated', sender: WINDOW_ID }); }catch(e){ console.warn('BroadcastChannel send failed', e); }
            
            await renderSidebar();
          }
        });
      }
    } else if (target.classList.contains('js-add-pdf')) {
      e.preventDefault();
      e.stopPropagation();
      
      console.log('🔥 PDF 뷰어: 목록별 PDF 업로드 버튼 클릭됨, listId:', listId);
      
      // 파일 선택 다이얼로그 열기
      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = '.pdf';
      fileInput.multiple = true;
      
      fileInput.onchange = async (event) => {
        const files = Array.from(event.target.files);
        if (files.length === 0) return;
        
        console.log(`🔥 PDF 뷰어: ${files.length}개 파일 선택됨, 대상 목록:`, listId);
        
        for (const file of files) {
          try {
            await handleFileUpload(file, listId);
          } catch (error) {
            console.error('❌ 파일 업로드 실패:', error);
            showToast(`파일 업로드 실패: ${file.name}`, 'error');
          }
        }
      };
      
      fileInput.click();
    } else {
      // PDF 항목이나 일반 목록 항목 클릭 시 PDF 로드 시도
      const node = findNode(window.state.userLists, listId);
      if (node) {
        console.log('🔥 PDF 뷰어: 노드 클릭됨:', node);
        
        // PDF 타입 노드인 경우 해당 PDF 로드
        if (node.type === 'pdf') {
          console.log('🔥 PDF 노드 클릭됨, 로드 시도:', { fileId: node.fileId, remoteUrl: node.remoteUrl });
          
          if (node.fileId) {
            // IndexedDB에서 파일 로드
            console.log('📄 FileId로 PDF 로드:', node.fileId);
            await loadPdfFromFileId(node.fileId);
          } else if (node.remoteUrl) {
            // 원격 URL에서 PDF 로드
            console.log('🌐 URL에서 PDF 로드:', node.remoteUrl);
            loadPdfFromUrl(node.remoteUrl);
          } else {
            console.warn('❌ PDF 노드에 fileId나 remoteUrl이 없습니다:', node);
            showToast('PDF 파일을 찾을 수 없습니다.', 'error');
          }
        }
        // 폴더 타입인 경우 선택 상태만 변경 (기존 동작 유지)
        else {
          console.log('📁 폴더 노드 클릭됨:', node.name);
          // 폴더 선택 처리는 필요시 여기에 추가
        }
      }
    }
  }

  // 사이드바 초기화 함수
  async function initSidebar() {
    try {
      console.log('🔥 PDF 뷰어: 사이드바 초기화 시작');
      
      // 🔥 ListCore 연결 및 초기화
      if (!window.ListCore) {
        console.error('❌ PDF 뷰어: ListCore가 없습니다!');
        return;
      }
      
      console.log('✅ PDF 뷰어: ListCore 발견됨');
      
      // ListCore 초기화
      await window.ListCore.init();
      console.log('✅ PDF 뷰어: ListCore 초기화 완료');
      
      // ListCore 이벤트 리스너 설정
      window.ListCore.on('stateChanged', (event) => {
        console.log('🔥 PDF VIEWER stateChanged 이벤트 수신:', event);
        
        // ListCore 상태를 PDF 뷰어 상태에 동기화
        try {
          const newLists = JSON.parse(JSON.stringify(window.ListCore.state.lists || []));
          if (Array.isArray(newLists)) {
            window.state.userLists = newLists;
            console.log('✅ PDF VIEWER: ListCore 상태 동기화 완료, 목록 개수:', newLists.length);
            renderSidebar();
          }
        } catch (e) {
          console.error('❌ PDF VIEWER: 상태 동기화 실패:', e);
        }
      });
      
      // 목록 로드
      console.log('📥 PDF 뷰어: 목록 로딩 중...');
      await window.ListCore.loadLists();
      console.log('✅ PDF 뷰어: 목록 로딩 완료');
      
      // 초기 상태 동기화
      window.state.userLists = JSON.parse(JSON.stringify(window.ListCore.state.lists || []));
      console.log('✅ PDF 뷰어: 초기 상태 동기화 완료, 목록 개수:', window.state.userLists.length);
      console.log('📋 PDF 뷰어: 로드된 목록들:', window.state.userLists);
      
      // 사이드바 렌더링
      console.log('🖼️ PDF 뷰어: 사이드바 렌더링 시작...');
      await renderSidebar();
      console.log('✅ PDF 뷰어: 사이드바 렌더링 완료');
      
      // 이벤트 리스너 추가
      const addListBtn = document.getElementById('addListBtn');
      if (addListBtn) {
        addListBtn.addEventListener('click', addNewList);
        console.log('✅ PDF 뷰어: 추가 버튼 이벤트 리스너 등록');
      }
      
      // Enter 키로 목록 추가
      const newListInput = document.getElementById('newListName');
      if (newListInput) {
        newListInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            addNewList();
          }
        });
        console.log('✅ PDF 뷰어: 입력창 키보드 이벤트 리스너 등록');
      }

      // 사이드바 클릭 이벤트 위임
      const sidebar = document.getElementById('sidebar');
      if (sidebar) {
        sidebar.addEventListener('click', handleListClick);
        console.log('✅ PDF 뷰어: 사이드바 클릭 이벤트 리스너 등록');
      }
      
      // BroadcastChannel 메시지 리스너
      const broadcastChannel = new BroadcastChannel('paperscout-sync');
      broadcastChannel.addEventListener('message', async (event) => {
        console.log('🔥 PDF 뷰어 BroadcastChannel 메시지 수신:', event.data);
        
        // ignore messages sent by this window
        if (!event.data || event.data.sender === WINDOW_ID) return;

        if (event.data.type === 'userLists-updated') {
          console.log('📥 PDF 뷰어: 다른 페이지에서 목록 업데이트됨, 동기화 중...');
          
          // 🔥 ListCore에서 다시 로드하여 동기화
          if (window.ListCore) {
            try {
              await window.ListCore.loadLists();
              window.state.userLists = JSON.parse(JSON.stringify(window.ListCore.state.lists || []));
              await renderSidebar();
              console.log('✅ PDF 뷰어: ListCore 동기화 완료');
            } catch (e) {
              console.error('PDF 뷰어: ListCore 동기화 실패:', e);
            }
          }
        }
      });
      console.log('✅ PDF 뷰어: BroadcastChannel 리스너 등록');
      
      console.log('✅ PDF 뷰어: 사이드바 초기화 완료');
    } catch (err) {
      console.error('❌ PDF 뷰어 사이드바 초기화 실패:', err);
    }
  }

  // PDF 뷰어 기본 기능들
  function wire() {
    console.log('🔧 PDF 뷰어: 기본 기능 초기화');
    
    const fileInput = document.getElementById('fileInput');
    const urlInput = document.getElementById('urlInput');
    const openUrlBtn = document.getElementById('openUrlBtn');
    const pdfViewerContainer = document.getElementById('pdfViewerContainer');
    const pdfFrame = document.getElementById('pdfFrame');

    if (fileInput) {
      fileInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (file && file.type === 'application/pdf') {
          console.log('🔥 PDF VIEWER: 파일 선택됨:', file.name);
          
          // 1. PDF 뷰어에 로드
          loadPdfFromFile(file);
          
          // 2. 파일을 목록에도 추가
          try {
            await enqueueOperation(async () => {
              // 현재 선택된 목록이 있다면 그곳에 추가, 없다면 루트에 추가
              const selectedListId = getSelectedListForUpload();
              await insertPdfNodeInViewer(selectedListId, file);
            });
          } catch (err) {
            console.error('PDF 뷰어: 파일 목록 추가 실패:', err);
          }
          
          // 파일 입력 초기화 (같은 파일을 다시 선택할 수 있도록)
          e.target.value = '';
        } else if (file) {
          showToast('PDF 파일만 업로드할 수 있습니다.', { variant: 'warn' });
        }
      });
    }

    // sidebar toggle button (left)
    const sidebarToggleBtn = document.getElementById('sidebarToggle');
    const SIDEBAR_LS_KEY = 'ps_sidebar_collapsed';
    const BC_NAME = 'paperscout-sync';

    function applySidebarCollapsed(collapsed){
      try{
        const side = document.getElementById('sidebar');
        const btn = document.getElementById('sidebarToggle');
        if(!side || !btn) return;
        if(collapsed) side.classList.add('collapsed'); else side.classList.remove('collapsed');
        btn.setAttribute('aria-expanded', String(!collapsed));
        btn.textContent = collapsed ? '▶' : '◀';
      }catch(e){ console.warn('applySidebarCollapsed failed', e); }
    }

    // Initialize from localStorage
    try{
      const v = localStorage.getItem(SIDEBAR_LS_KEY);
      if(v === '1' || v === 'true') applySidebarCollapsed(true);
      else if(v === '0' || v === 'false' || v === null) applySidebarCollapsed(false);
    }catch(e){ /* ignore */ }

    // BroadcastChannel for cross-window sync
    let _bc = null;
  try{ if(typeof BroadcastChannel !== 'undefined'){ _bc = new BroadcastChannel(BC_NAME); _bc.onmessage = (ev)=>{ try{ const d = ev.data; if(!d || d.sender === WINDOW_ID) return; if(d && d.type === 'sidebar-collapsed'){ applySidebarCollapsed(!!d.collapsed); } }catch(e){}} } }catch(e){ console.warn('BroadcastChannel init failed', e); }

    if (sidebarToggleBtn) {
      sidebarToggleBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const side = document.getElementById('sidebar');
        if (!side) return;
        const isCollapsed = side.classList.toggle('collapsed');
        sidebarToggleBtn.setAttribute('aria-expanded', String(!isCollapsed));
        // update icon (chevrons)
        sidebarToggleBtn.textContent = isCollapsed ? '▶' : '◀';

        // persist and broadcast
        try{ localStorage.setItem(SIDEBAR_LS_KEY, isCollapsed ? '1' : '0'); }catch(e){}
  try{ if(_bc) _bc.postMessage({ type:'sidebar-collapsed', collapsed: !!isCollapsed, sender: WINDOW_ID }); }catch(e){}
      });
    }

    if (openUrlBtn && urlInput) {
      openUrlBtn.addEventListener('click', () => {
        const url = urlInput.value.trim();
        if (url) {
          loadPdfFromUrl(url);
        }
      });
      
      urlInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          openUrlBtn.click();
        }
      });
    }

    // 드래그 앤 드롭
    if (pdfViewerContainer) {
      pdfViewerContainer.addEventListener('dragover', (e) => {
        e.preventDefault();
        pdfViewerContainer.classList.add('dragover');
      });

      pdfViewerContainer.addEventListener('dragleave', (e) => {
        if (!pdfViewerContainer.contains(e.relatedTarget)) {
          pdfViewerContainer.classList.remove('dragover');
        }
      });

      pdfViewerContainer.addEventListener('drop', (e) => {
        e.preventDefault();
        pdfViewerContainer.classList.remove('dragover');
        
        const files = e.dataTransfer.files;
        if (files.length > 0) {
          const file = files[0];
          if (file.type === 'application/pdf') {
            loadPdfFromFile(file);
          }
        }
      });
    }

    console.log('✅ PDF 뷰어: 기본 기능 초기화 완료');
  }

  function loadPdfFromFile(file) {
    console.log('📄 PDF 파일 로딩:', file.name);
    const url = URL.createObjectURL(file);
    loadPdf(url);
  }

  function loadPdfFromUrl(url) {
    console.log('🌐 loadPdfFromUrl 호출됨, URL:', url);
    loadPdf(url);
  }

  function loadPdf(url) {
    console.log('🔥 loadPdf 함수 호출됨, URL:', url);
    // PDF.js를 사용하여 PDF 로드
    loadPdfWithPdfJs(url);
  }

  // URL 파라미터에서 PDF 로드
  async function loadPdfFromParams() {
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const fileId = urlParams.get('fileId');
      const url = urlParams.get('url');
      
      console.log('🔍 URL 파라미터 확인:', { fileId, url });
      
      if (fileId) {
        console.log('📄 URL 파라미터에서 fileId 발견:', fileId);
        await loadPdfFromFileId(fileId);
      } else if (url) {
        console.log('🌐 URL 파라미터에서 URL 발견:', url);
        loadPdfFromUrl(decodeURIComponent(url));
      } else {
        console.log('📝 URL 파라미터에 PDF 정보 없음, 사용 가능한 첫 번째 PDF 로드 시도');
        // URL 파라미터가 없을 때도 첫 번째 PDF 로드 시도
        await loadFirstAvailablePdf();
      }
    } catch (err) {
      console.error('❌ URL 파라미터 처리 실패:', err);
    }
  }

  // 사용 가능한 첫 번째 PDF 로드 (URL 파라미터 없을 때)
  async function loadFirstAvailablePdf() {
    try {
      console.log('🔍 사용 가능한 첫 번째 PDF 검색 중...');
      
      // IndexedDB 열기
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('paperscout', 2);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });

      // 모든 파일 목록 가져오기
      const transaction = db.transaction(['files'], 'readonly');
      const store = transaction.objectStore('files');
      const allFiles = await new Promise((resolve, reject) => {
        const request = store.getAll();
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });

      await tryLoadFirstAvailablePdf(allFiles);
    } catch (err) {
      console.error('❌ 첫 번째 PDF 로드 실패:', err);
    }
  }

  // FileId로 PDF 로드
  async function loadPdfFromFileId(fileId) {
    try {
      console.log('📄 FileId로 PDF 로드 시도:', fileId);
      
      // IndexedDB에서 PDF 파일 로드 (메인 페이지와 동일한 방식)
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('paperscout', 2); // 메인 페이지와 동일한 버전
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = (event) => {
          const db = event.target.result;
          if (!db.objectStoreNames.contains('files')) {
            db.createObjectStore('files', { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains('kv')) {
            db.createObjectStore('kv');
          }
        };
      });

      console.log('✅ IndexedDB 연결 성공');
      
      // 먼저 files 스토어에 있는 모든 파일들을 확인
      const allFilesTransaction = db.transaction(['files'], 'readonly');
      const allFilesStore = allFilesTransaction.objectStore('files');
      const allFiles = await new Promise((resolve, reject) => {
        const request = allFilesStore.getAll();
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      
      console.log('📋 IndexedDB files 스토어의 모든 파일들:', allFiles);
      console.log('📋 찾고 있는 fileId:', fileId);
      
      const transaction = db.transaction(['files'], 'readonly');
      const store = transaction.objectStore('files');
      const result = await new Promise((resolve, reject) => {
        const request = store.get(fileId);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });

      if (result && result.blob) {
        console.log('📄 IndexedDB에서 찾은 파일:', result);
        console.log('📋 result.blob 타입:', typeof result.blob, result.blob.constructor.name);
        
        let pdfBlob = result.blob;
        
        console.log('🔍 메인 파일 blob 타입 확인:', typeof pdfBlob, pdfBlob?.constructor?.name);
        console.log('🔍 File 인스턴스 체크:', pdfBlob instanceof File);
        console.log('🔍 Blob 인스턴스 체크:', pdfBlob instanceof Blob);
        
        // File 객체도 Blob의 하위 클래스이므로 직접 사용 시도
        if (pdfBlob && (pdfBlob instanceof File || pdfBlob instanceof Blob)) {
          console.log('✅ IndexedDB에서 PDF 파일 로드 성공, 타입:', pdfBlob.constructor.name, '크기:', pdfBlob.size, 'bytes');
          try {
            const url = URL.createObjectURL(pdfBlob);
            console.log('🔗 생성된 URL:', url);
            loadPdf(url);
          } catch (err) {
            console.error('❌ URL 생성 실패, FileReader로 변환 시도:', err);
            
            // URL 생성 실패 시 FileReader로 변환 시도
            try {
              const fileReader = new FileReader();
              const arrayBuffer = await new Promise((resolve, reject) => {
                fileReader.onload = () => resolve(fileReader.result);
                fileReader.onerror = () => reject(fileReader.error);
                fileReader.readAsArrayBuffer(pdfBlob);
              });
              const newBlob = new Blob([arrayBuffer], { type: 'application/pdf' });
              console.log('✅ FileReader로 변환된 Blob:', newBlob);
              const url = URL.createObjectURL(newBlob);
              loadPdf(url);
            } catch (conversionErr) {
              console.error('❌ FileReader 변환도 실패:', conversionErr);
              return;
            }
          }
        } else {
          console.error('❌ PDF 파일의 blob이 유효하지 않음:', pdfBlob);
          // blob이 유효하지 않은 경우에도 대안 로직 실행
          await tryLoadFirstAvailablePdf(allFiles);
        }
      } else {
        console.error('❌ IndexedDB에서 PDF 파일을 찾을 수 없음:', fileId);
        console.log('📋 검색 결과:', result);
        console.log('📋 result.blob 타입:', typeof result?.blob, result?.blob);
        
        // 즉시 대안 로직 실행
        await tryLoadFirstAvailablePdf(allFiles);
      }
    } catch (err) {
      console.error('❌ FileId로 PDF 로드 실패:', err);
    }
  }

  // 대안: 첫 번째 사용 가능한 PDF 파일 로드
  async function tryLoadFirstAvailablePdf(allFiles) {
    try {
      // IndexedDB에 실제로 저장된 모든 파일들을 확인
      console.log('📋 전체 파일 목록 (allFiles):', allFiles.map(f => ({
        key: f.id || f.key,
        name: f.name,
        type: f.type,
        hasBlob: !!f.blob,
        blobType: f.blob?.constructor?.name
      })));
      
      // 대안: 파일이 없으면 파일 목록에서 첫 번째 PDF 파일 시도
      const pdfFiles = allFiles.filter(file => file.type === 'application/pdf' || file.name?.endsWith('.pdf'));
        console.log('📋 전체 PDF 파일 목록:', pdfFiles);
        
        if (pdfFiles.length > 0) {
          console.log('🔄 대안: 사용 가능한 첫 번째 PDF 파일 로드:', pdfFiles[0]);
          const firstPdf = pdfFiles[0];
          console.log('🔍 firstPdf 전체 구조:', firstPdf);
          console.log('🔍 firstPdf.blob:', firstPdf.blob);
          console.log('🔍 firstPdf 키들:', Object.keys(firstPdf));
          
          // 다양한 방법으로 Blob 찾기
          let pdfBlob = null;
          
          // 방법 1: .blob 속성
          if (firstPdf.blob && (firstPdf.blob instanceof File || firstPdf.blob instanceof Blob)) {
            pdfBlob = firstPdf.blob;
            console.log('✅ .blob 속성에서 발견');
          }
          // 방법 2: firstPdf 자체가 File/Blob
          else if (firstPdf instanceof File || firstPdf instanceof Blob) {
            pdfBlob = firstPdf;
            console.log('✅ firstPdf 자체가 File/Blob');
          }
          // 방법 3: 다른 속성들 확인
          else {
            console.log('🔍 다른 속성들 확인:');
            Object.keys(firstPdf).forEach(key => {
              const val = firstPdf[key];
              console.log(`  ${key}:`, typeof val, val?.constructor?.name);
              if (val instanceof File || val instanceof Blob) {
                console.log(`🎯 ${key}에서 File/Blob 발견:`, val);
                if (!pdfBlob) pdfBlob = val;
              }
            });
          }
          
          if (pdfBlob && (pdfBlob instanceof File || pdfBlob instanceof Blob)) {
            console.log('✅ 대안 PDF 파일 로드 시도, 타입:', pdfBlob.constructor.name, '크기:', pdfBlob.size, 'bytes');
            try {
              const url = URL.createObjectURL(pdfBlob);
              console.log('🔗 대안 파일 생성된 URL:', url);
              loadPdf(url);
            } catch (err) {
              console.error('❌ 대안 파일 URL 생성 실패, FileReader로 변환 시도:', err);
              
              // URL 생성 실패 시 FileReader로 변환 시도
              try {
                const fileReader = new FileReader();
                const arrayBuffer = await new Promise((resolve, reject) => {
                  fileReader.onload = () => resolve(fileReader.result);
                  fileReader.onerror = () => reject(fileReader.error);
                  fileReader.readAsArrayBuffer(pdfBlob);
                });
                const newBlob = new Blob([arrayBuffer], { type: 'application/pdf' });
                console.log('✅ 대안 파일 FileReader로 변환된 Blob:', newBlob);
                const url = URL.createObjectURL(newBlob);
                loadPdf(url);
              } catch (conversionErr) {
                console.error('❌ 대안 파일 FileReader 변환도 실패:', conversionErr);
                return;
              }
            }
          } else {
            console.error('❌ 대안 PDF 파일의 blob이 유효하지 않음:', pdfBlob);
            console.log('🔍 firstPdf 전체 객체:', firstPdf);
          }
        } else {
          console.log('📝 IndexedDB에 PDF 파일이 없습니다.');
        }
    } catch (err) {
      console.error('❌ 대안 PDF 로딩 실패:', err);
    }
  }

  // 앱 초기화
  async function initApp() {
    console.log('🚀 PDF 뷰어 앱 초기화 시작');
    
    // PDF.js 초기화
    await initPdfJs();
    
    wire();
    
    // ListCore가 로드될 때까지 대기
    let attempts = 0;
    while (!window.ListCore && attempts < 50) {
      console.log('PDF 뷰어: ListCore 로딩 대기 중...', attempts);
      await new Promise(resolve => setTimeout(resolve, 100));
      attempts++;
    }
    
    if (!window.ListCore) {
      console.error('PDF 뷰어: ListCore 로딩 실패!');
      return;
    }
    
    console.log('PDF 뷰어: ListCore 로딩 완료');
    await initSidebar();
    
    // URL 파라미터에서 PDF 로드
    console.log('🔍 URL 파라미터 처리 시작');
    await loadPdfFromParams();
    
    // 🔥 닫기 버튼 이벤트 리스너 추가 — 우선 뒤로가기(history.back)를 시도하고, 실패하면 기존 복귀 URL로 폴백
    const closeBtn = document.getElementById('closeBtn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        console.log('🔥 닫기 버튼 클릭됨 - 먼저 history.back() 시도');

        // Try to go back in history when possible. If that doesn't navigate (no history/referrer),
        // fall back to returning to the search/index page with preserved search params.
        const tryBack = () => {
          try {
            if (document.referrer && document.referrer !== '') {
              console.log('🔁 document.referrer 존재, history.back() 호출');
              history.back();
              return true;
            }
            // If history length suggests a previous entry, attempt back as well
            if (history.length > 1) {
              console.log('🔁 history.length > 1, history.back() 호출');
              history.back();
              return true;
            }
          } catch (err) {
            console.warn('history.back() 호출 중 오류:', err);
          }
          return false;
        };

        const didBack = tryBack();
        if (didBack) {
          // Set a short timeout to detect if navigation didn't happen and then fallback
          setTimeout(() => {
            // If still on same page after 300ms, perform fallback navigation
            if (location.pathname.includes('pdf-viewer') || location.pathname === '/pdf-viewer.html') {
              console.log('⏱️ 뒤로가기가 동작하지 않음 - 폴백으로 인덱스 페이지로 이동');
              performFallbackReturn();
            }
          }, 300);
        } else {
          performFallbackReturn();
        }
      });
    }

    function performFallbackReturn() {
      // URL 파라미터에서 검색 상태 추출
      const urlParams = new URLSearchParams(window.location.search);
      const searchParams = new URLSearchParams();

      // 검색 관련 파라미터들을 추출
      ['q', 'sort', 'page', 'yFrom', 'yTo', 'journal'].forEach(param => {
        if (urlParams.has(param)) {
          searchParams.set(param, urlParams.get(param));
        }
      });

      // 검색 상태가 있으면 해당 상태로 메인 페이지로 이동
      const searchQuery = searchParams.toString();
      const returnUrl = searchQuery ? `/index.html?${searchQuery}` : '/index.html';

      console.log('🔍 폴백: 검색 상태로 복귀:', returnUrl);
      window.location.href = returnUrl;
    }
    
    // PDF.js 초기화
    initPdfJs();
    
    console.log('✅ PDF 뷰어 앱 초기화 완료');
  }

  // PDF.js 초기화 및 이벤트 리스너 설정
  function initPdfJs() {
    console.log('🔥 PDF.js 초기화 시작');
    
    // Canvas 요소 가져오기
    canvas = document.getElementById('pdfCanvas');
    if (!canvas) {
      console.error('❌ PDF Canvas 요소를 찾을 수 없습니다');
      return;
    }
    ctx = canvas.getContext('2d');
    
    // PDF.js worker 설정
    if (typeof pdfjsLib !== 'undefined') {
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
      console.log('✅ PDF.js 라이브러리 로드됨');
    } else {
      console.error('❌ PDF.js 라이브러리가 로드되지 않았습니다');
      return;
    }
    
    // 페이지 네비게이션 버튼 이벤트
    const prevPageBtn = document.getElementById('prevPage');
    const nextPageBtn = document.getElementById('nextPage');
    const zoomInBtn = document.getElementById('zoomIn');
    const zoomOutBtn = document.getElementById('zoomOut');
    
    if (prevPageBtn) {
      prevPageBtn.addEventListener('click', () => {
        if (currentPage > 1) {
          currentPage--;
          renderPage(currentPage);
        }
      });
    }
    
    if (nextPageBtn) {
      nextPageBtn.addEventListener('click', () => {
        if (currentPage < totalPages) {
          currentPage++;
          renderPage(currentPage);
        }
      });
    }
    
    if (zoomInBtn) {
      zoomInBtn.addEventListener('click', () => {
        currentScale *= 1.2;
        renderPage(currentPage);
        updateZoomDisplay();
      });
    }
    
    if (zoomOutBtn) {
      zoomOutBtn.addEventListener('click', () => {
        currentScale /= 1.2;
        renderPage(currentPage);
        updateZoomDisplay();
      });
    }
  }

  // PDF 로드 함수
  async function loadPdfWithPdfJs(url) {
    console.log('🔥 PDF.js로 PDF 로드 시작:', url);
    
    try {
      // 기존 PDF 정리
      if (pdfDoc) {
        pdfDoc.destroy();
        pdfDoc = null;
      }
      
      // PDF 문서 로드
      const loadingTask = pdfjsLib.getDocument(url);
      pdfDoc = await loadingTask.promise;
      totalPages = pdfDoc.numPages;
      currentPage = 1;
      
      console.log('✅ PDF 로드 성공, 총 페이지:', totalPages);
      
      // 툴바 표시
      const toolbar = document.getElementById('pdfToolbar');
      if (toolbar) {
        toolbar.style.display = 'block';
      }
      
      // 첫 페이지 렌더링
      await renderPage(1);
      updatePageInfo();
      updateZoomDisplay();
      
    } catch (error) {
      console.error('❌ PDF 로드 실패:', error);
      alert('PDF를 로드할 수 없습니다: ' + error.message);
    }
  }

  // PDF 페이지 렌더링
  async function renderPage(pageNum) {
    if (!pdfDoc || !canvas || !ctx) {
      console.error('❌ PDF 문서 또는 캔버스가 준비되지 않았습니다');
      return;
    }
    
    try {
      console.log('🔥 페이지 렌더링 시작:', pageNum);
      
      const page = await pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale: currentScale });
      
      // 캔버스 크기 설정
      canvas.height = viewport.height;
      canvas.width = viewport.width;
      
      // 렌더링 컨텍스트 설정
      const renderContext = {
        canvasContext: ctx,
        viewport: viewport
      };
      
      // 페이지 렌더링
      await page.render(renderContext).promise;
      
      console.log('✅ 페이지 렌더링 완료:', pageNum);
      
    } catch (error) {
      console.error('❌ 페이지 렌더링 실패:', error);
    }
  }

  // 페이지 정보 업데이트
  function updatePageInfo() {
    const currentPageSpan = document.getElementById('currentPage');
    const totalPagesSpan = document.getElementById('totalPages');
    
    if (currentPageSpan) currentPageSpan.textContent = currentPage;
    if (totalPagesSpan) totalPagesSpan.textContent = totalPages;
  }

  // 줌 레벨 표시 업데이트
  function updateZoomDisplay() {
    const zoomLevelSpan = document.getElementById('zoomLevel');
    if (zoomLevelSpan) {
      zoomLevelSpan.textContent = Math.round(currentScale * 100) + '%';
    }
  }

  // 기존 loadPdf 함수를 PDF.js 버전으로 대체
  window.loadPdfWithPdfJs = loadPdfWithPdfJs;

  if(document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }

})();