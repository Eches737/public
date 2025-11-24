// app.js - 테마 제거, 검색폼 중앙정렬은 CSS로 처리됨(자바스크립트 불필요)
// 초기화: localStorage.uploadEndpoint 설정
localStorage.setItem('uploadEndpoint', 'http://localhost:5001');
// psDebug helper: when window.__PAPERSCOUT_DEBUG__ is truthy, forward to window.psDebug or console.debug
const psDebug = function(){
  try{
    if(!window.__PAPERSCOUT_DEBUG__) return;
    const fn = (typeof window.psDebug === 'function') ? window.psDebug : console.debug.bind(console);
    fn.apply(console, arguments);
  }catch(e){}
};
// Defensive: when third-party libs (e.g. pdf.js) add non-passive wheel/touch listeners
// this can trigger Chrome performance warnings. We add a guarded wrapper that
// forces passive:true for wheel/touch listeners unless the caller explicitly
// requests non-passive behavior (options && options.passive === false).
// NOTE: forcing passive prevents calling event.preventDefault() inside those
// listeners, so keep this conservative. It only changes listeners that do not
// explicitly opt-out by passing { passive: false }.
try{
  (function(){
    const _add = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function(type, listener, options){
      try{
        if(!type) return _add.call(this, type, listener, options);
        const t = String(type).toLowerCase();
        if((t === 'wheel' || t === 'touchstart' || t === 'touchmove')){
          // if caller passed an options object that explicitly sets passive:false, respect it
          if(typeof options === 'object'){
            if(options && options.passive === false) return _add.call(this, type, listener, options);
            // otherwise ensure passive is true
            options = Object.assign({}, options, { passive: true });
            return _add.call(this, type, listener, options);
          }
          // if boolean (useCapture) or undefined, install with passive:true
          return _add.call(this, type, listener, { passive: true });
        }
      }catch(e){ /* fallthrough to default */ }
      return _add.call(this, type, listener, options);
    };
  })();
}catch(e){ /* ignore in very old browsers */ }
function showToast(message, { timeout=3500, variant='info' } = {}){
  try{
    let container = document.getElementById('ps-toast-container');
    if(!container){ container = document.createElement('div'); container.id = 'ps-toast-container'; document.body.appendChild(container); }
    const node = document.createElement('div'); node.className = 'ps-toast ps-toast--' + (variant||'info');
    node.textContent = message;
    const btn = document.createElement('button'); btn.className='ps-toast__close'; btn.innerHTML='✕'; btn.addEventListener('click', ()=>{ try{ node.remove(); }catch(e){} });
    node.appendChild(btn);
    container.appendChild(node);
    // auto remove
    setTimeout(()=>{ try{ node.remove(); }catch(e){} }, timeout);
    return node;
  }catch(e){ console.warn('showToast failed', e); }
}

// Insert-related logger: emits psDebug and console.info for important insertion/duplication events
function logInsertEvent(eventType, details){
  try{
    const d = Object.assign({ ts: new Date().toISOString(), event: eventType }, details || {});
    psDebug('[insert-event]', d);
    try{ console.info('[insert-event]', d); }catch(e){}
  }catch(e){ /* noop */ }
}
let _resultsHandlerInstalled = false;
const $ = (s, el=document)=> el.querySelector(s);
const state = { page:1, pageSize:20, q:"", sort:"relevance", yFrom:"", yTo:"", journal:"", total:0, items:[], userLists: [], selectedListId: null, llmModel: null, llmForced: false, hasSearched: false, selectedPublishers: new Set() };
// temporary parent id when adding a PDF from the sidebar
let pendingPdfParentId = null;

const els = {
  form: $("#searchForm"),
  q: $("#q"), sort: $("#sort"),
  yFrom: $("#yFrom"), yTo: $("#yTo"), journal: $("#journal"),
  chips: $("#activeChips"),
  resultsList: $("#resultsList"),
  resultsMeta: $("#resultsMeta"),
  resultsSection: $("#resultsSection"),
  pagination: $("#pagination"),
  empty: $("#emptyState"),
  exportCsv: $("#exportCsv"),
  itemTmpl: $("#resultItemTemplate"),
  // sidebar elements
  sidebarToggle: $("#sidebarToggle"),
  newListName: $("#newListName"),
  addListBtn: $("#addListBtn"),
  userLists: $("#userLists"),
  // essential header buttons only
  publishersBtn: $("#publishersBtn"),
  // PDF file input for upload
  pdfInput: $("#pdfInput"),
  // sidebar adder (input + add button) and static tabs container (hidden by default)
  sidebarAdder: document.querySelector('.sidebar__adder'),
  // list contents container
  listContents: $("#listContents"),
  sidebarTabs: $("#staticSidebarTabs"),
};
// unique id for this window/tab to avoid processing our own BroadcastChannel messages
const APP_WINDOW_ID = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : ('win-' + Math.random().toString(36).slice(2));

function renderChips(){
  const chips=[];
  if(state.q) chips.push(["q",`키워드: ${state.q}`]);
  if(state.yFrom) chips.push(["yFrom",`>= ${state.yFrom}`]);
  if(state.yTo) chips.push(["yTo",`<= ${state.yTo}`]);
  if(state.journal) chips.push(["journal",`저널: ${state.journal}`]);
  try{
    const html = chips.map(([k,t])=>`<span class="chip" data-key="${k}">${t}</span>`).join("");
    if(els.chips) els.chips.innerHTML = html;
  }catch(e){ console.warn('renderChips failed', e); }
}


/* ---------- sidebar: user lists with nested sublists ---------- */
function escapeHtml(str){ return String(str).replace(/[&<>"']/g, s=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[s]); }

// 🔥 현재 검색 상태를 URL 파라미터로 인코딩
function encodeSearchState() {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.sort && state.sort !== 'relevance') params.set('sort', state.sort);
  if (state.page && state.page > 1) params.set('page', state.page);
  if (state.yFrom) params.set('yFrom', state.yFrom);
  if (state.yTo) params.set('yTo', state.yTo);
  if (state.journal) params.set('journal', state.journal);
  const searchParams = params.toString();
  return searchParams ? `&${searchParams}` : '';
}

// 🔥 PDF 뷰어로 이동하는 URL 생성 (검색 상태 포함)
function createPdfViewerUrl(baseParams) {
  const searchState = encodeSearchState();
  return `/pdf-viewer.html?${baseParams}${searchState}`;
}

function renderSidebar(){
  console.log('🔥 RENDER SIDEBAR: Starting render...');
  console.log('🔍 Current state.userLists:', state.userLists ? state.userLists.length : 'null/undefined');
  console.log('🔍 state.userLists structure:', JSON.stringify(state.userLists, null, 2));
  
  const ul = els.userLists;
  if(!ul) {
    console.error('❌ RENDER SIDEBAR: userLists element not found!');
    return;
  }
  ul.innerHTML = "";
  const build = (lists, container)=>{
    for(const list of lists){
      const li = document.createElement('li');
      li.className = 'user-list-item';
      // mark PDF nodes specially so we can style them and avoid rendering children
      if(list.type === 'pdf') li.classList.add('user-list-item--pdf');
      li.dataset.id = list.id;
  // Make list items draggable (folders and PDFs) so users can reorder/move lists and PDFs
  li.draggable = true;
      if(state.selectedListId === list.id) li.setAttribute('aria-current','true');
      const actions = document.createElement('div'); actions.className='user-list__actions';
      // For PDF nodes we don't allow adding children; show only delete. For lists show add-child + delete.
      if(list.type === 'pdf'){
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
      // set draggable handlers only for draggable items
        if(li.draggable){
        li.addEventListener('dragstart', (ev)=>{
          try{
            console.log('🔥 DRAG START:', list.id, list.name);
            
            // 🔍 이벤트 전파 중단 - 중첩된 구조에서 부모까지 드래그되는 것을 방지
            ev.stopPropagation();
            
            // expose both a custom/typed id and a plain-text fallback for cross-window compatibility
            ev.dataTransfer.setData('text/x-list-id', list.id);
            ev.dataTransfer.setData('text/plain', list.id);
            ev.dataTransfer.effectAllowed = 'move';
            li.classList.add('dragging');
            psDebug('[dragstart][sidebar]', list.id);
          }catch(e){ console.warn('sidebar dragstart setData failed', e); }
        });
        li.addEventListener('dragend', (ev)=>{ 
          // 🔍 이벤트 전파 중단 - 중첩된 구조에서 중복 처리 방지
          ev.stopPropagation();
          li.classList.remove('dragging'); 
        });
        
        // 개별 목록 항목에 대한 드래그오버 효과 추가
        li.addEventListener('dragover', (ev) => {
          ev.stopPropagation();
          if (list.type !== 'pdf') { // PDF는 드롭 대상이 될 수 없음
            ev.preventDefault();
            ev.dataTransfer.dropEffect = 'move';
            li.classList.add('drag-over');
          }
        });
        
        li.addEventListener('dragleave', (ev) => {
          ev.stopPropagation();
          if (!li.contains(ev.relatedTarget)) {
            li.classList.remove('drag-over');
          }
        });
      }
      // Do not render nested children under PDF nodes — PDFs are leaves
      if(list.type !== 'pdf' && Array.isArray(list.children) && list.children.length>0){
        const sub = document.createElement('ul'); sub.className='user-lists user-lists--nested';
        sub.dataset.parentId = list.id;
        try{ sub.dataset.dropIndex = ''; }catch(e){}
        li.appendChild(sub);
        build(list.children, sub);
      }
    }
  };
  // root ul parent is empty (top-level)
  ul.dataset.parentId = '';
  try{ ul.dataset.dropIndex = ''; }catch(e){}
  build(state.userLists, ul);
  // attach drop handlers to all list containers (include root ul and nested uls)
  const nested = Array.from(ul.querySelectorAll('ul'));
  const containers = [ul, ...nested];
  containers.forEach(u=>{
    // ensure handlers replaced
    u.addEventListener('dragover', (e)=>{
      e.preventDefault();
      // if files are being dragged from the OS/browser, indicate copy; otherwise move
      const hasFiles = e.dataTransfer && e.dataTransfer.types && (Array.from(e.dataTransfer.types).includes('Files') || (e.dataTransfer.files && e.dataTransfer.files.length>0));
      e.dataTransfer.dropEffect = hasFiles ? 'copy' : 'move';
      u.classList.add('drop-target');
      // clear previous indicators
      u.querySelectorAll('.drop-before, .drop-after').forEach(el=> el.classList.remove('drop-before','drop-after'));
      const targetLi = e.target.closest('.user-list-item');
      let index = u.children.length; // default append at this depth
      
      // 🔥 한 단계 더 깊이 들어가도록 수정: 항상 가장 가까운 목록 항목을 타겟으로 설정
      if(targetLi && targetLi.parentElement === u){
        const rect = targetLi.getBoundingClientRect();
        const before = e.clientY < rect.top + rect.height/2;
        if(before){ targetLi.classList.add('drop-before'); index = Array.from(u.children).indexOf(targetLi); }
        else { targetLi.classList.add('drop-after'); index = Array.from(u.children).indexOf(targetLi) + 1; }
        // 🔥 항상 해당 항목의 자식으로 이동하도록 설정
        try{ u.dataset.dropTargetItemId = targetLi.dataset.id || ''; u.dataset.dropBefore = '0'; }catch(e){}
      } else {
        // 🔥 직접적인 목록 항목이 없어도, 가장 가까운 항목을 찾아서 설정
        const allItems = Array.from(u.querySelectorAll('.user-list-item'));
        if(allItems.length > 0) {
          // 마지막 항목의 자식으로 추가
          const lastItem = allItems[allItems.length - 1];
          try{ u.dataset.dropTargetItemId = lastItem.dataset.id || ''; u.dataset.dropBefore = '0'; }catch(e){}
        } else {
          try{ u.dataset.dropTargetItemId = ''; u.dataset.dropBefore = '0'; }catch(e){}
        }
      }
      u.dataset.dropIndex = String(index);
    });

    u.addEventListener('dragleave', ()=>{
      u.classList.remove('drop-target');
      u.dataset.dropIndex = '';
      try{ u.dataset.dropTargetItemId = ''; u.dataset.dropBefore = '0'; }catch(e){}
      u.querySelectorAll('.drop-before, .drop-after').forEach(el=> el.classList.remove('drop-before','drop-after'));
      // 드래그오버 애니메이션도 정리
      u.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    });

  u.addEventListener('drop', async (e)=>{
      // 🔍 이벤트 전파 중단 - 중첩된 컨테이너에서 중복 처리 방지
      e.stopPropagation();
      
      console.log('[DEBUG] Drop event triggered', {
        files: e.dataTransfer?.files?.length || 0,
        types: Array.from(e.dataTransfer?.types || []),
        target: e.target
      });
      
      // prevent duplicate handling when multiple nested handlers fire for the same event
      if(e && e._paperscoutHandled) return;
      if(e) e._paperscoutHandled = true;
      e.preventDefault(); 
      u.classList.remove('drop-target');
      // 드래그오버 애니메이션 정리
      u.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
  try{ psDebug('[sidebar drop] types=', e.dataTransfer && e.dataTransfer.types, 'dataset.parentId=', u.dataset.parentId, 'dropIndex=', u.dataset.dropIndex); }catch(_){ }
      const files = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length ? Array.from(e.dataTransfer.files) : [];
      // By default the dataset.parentId points to the list that owns this UL's children.
      // To insert one depth deeper, prefer dataset.dropTargetItemId (the specific LI under
      // the pointer) and insert into that item's children instead.
      let targetParentId = u.dataset.parentId || null;
      // try dataset first, but compute a robust fallback index from the event if missing
      let parsed = parseInt(u.dataset.dropIndex, 10);
      let idx = Number.isFinite(parsed) ? parsed : NaN;
      
      // 🔥 항상 한 단계 더 깊이 들어가도록 수정
      // If a target item id is set, switch to inserting into that item's children (one depth deeper)
      try{
        const dropItem = (u.dataset.dropTargetItemId || '').trim();
        const dropBefore = (u.dataset.dropBefore === '1');
        if(dropItem){
          // set parent to the item id and compute index relative to its children
          targetParentId = dropItem;
          const parentNode = findNodeById(state.userLists, targetParentId);
          const childCount = parentNode && Array.isArray(parentNode.children) ? parentNode.children.length : 0;
          idx = dropBefore ? 0 : childCount;
        } else {
          // 🔥 dropTargetItemId가 없어도 마지막으로 호버한 목록으로 이동
          const targetLi = e.target && e.target.closest ? e.target.closest('.user-list-item') : null;
          if(targetLi && targetLi.dataset.id && targetLi.parentElement === u){
            // 해당 항목의 자식으로 추가
            targetParentId = targetLi.dataset.id;
            const parentNode = findNodeById(state.userLists, targetParentId);
            const childCount = parentNode && Array.isArray(parentNode.children) ? parentNode.children.length : 0;
            idx = childCount; // 마지막에 추가
          }
        }
      }catch(e){ 
        console.warn('드롭 타겟 처리 중 오류:', e);
        /* ignore and fallback to original idx */ 
      }
      if(Number.isNaN(idx)){
        // determine index at drop time using the pointer position and nearest list item
        const targetLi = e.target && e.target.closest ? e.target.closest('.user-list-item') : null;
        if(targetLi && targetLi.parentElement === u){
          const rect = targetLi.getBoundingClientRect();
          const before = e.clientY < rect.top + rect.height/2;
          const baseIndex = Array.prototype.indexOf.call(u.children, targetLi);
          idx = before ? baseIndex : baseIndex + 1;
        } else {
          // default to append
          idx = u.children.length;
        }
      }
  // If files were dropped (from desktop or another tab), insert them as new PDF nodes
      if(files.length){
        console.log('[DEBUG] Processing files:', files.map(f => ({ name: f.name, type: f.type, size: f.size })));
        
        // Queue the whole file-insert operation so multiple simultaneous drops
        // don't interleave and cause inconsistent tree mutations.
        await enqueueOperation(async ()=>{
          for(const f of files){
            console.log('[DEBUG] Processing file:', f.name, f.type);
            if(f.type !== 'application/pdf'){
              console.warn('Skipped non-PDF file drop:', f.name, f.type); 
              continue;
            }
            try{
              console.log('[DEBUG] Calling insertPdfNodeAt for:', f.name);
              await insertPdfNodeAt(targetParentId, f, Number.isNaN(idx) ? undefined : idx);
              console.log('[DEBUG] Successfully inserted PDF:', f.name);
            }catch(err){ 
              console.error('[DEBUG] insertPdfNodeAt failed for', f.name, ':', err); 
            }
          }
          try{ 
            console.log('[DEBUG] Rendering sidebar and saving lists');
            renderSidebar(); saveLists(); renderListContents(); 
          }catch(e){
            console.error('[DEBUG] Error during render/save:', e);
          }
        });
        u.dataset.dropIndex = '';
        u.querySelectorAll('.drop-before, .drop-after').forEach(el=> el.classList.remove('drop-before','drop-after'));
        return;
      }
      // If a search-result was dragged (custom mime), create a pdf node referencing the remote URL
      try{
        const resultData = e.dataTransfer.getData('application/x-paperscout-result');
        if(resultData){
          try{
            const parsed = JSON.parse(resultData);
            // Use the already-computed targetParentId/idx above so drops onto an LI
            // insert into that item's children (one level deeper) instead of at the
            // UL's level. Do NOT shadow `targetParentId` here.
            const node = { id: crypto.randomUUID(), name: parsed.title || (parsed.url? parsed.url.split('/').pop() : '문서'), remoteUrl: parsed.url || null, type: 'pdf', children: [] };
            // insert at index if provided
            if(Number.isFinite(idx) && !Number.isNaN(idx)){
              // Queue the insert operation so it won't race with other concurrent inserts/moves
              await enqueueOperation(async ()=>{
                try{
                  if(window.ListCore && typeof window.ListCore.insertAtIndex === 'function'){
                    try{
                      await window.ListCore.insertAtIndex(state.userLists, targetParentId, idx, node, { clone:false, regenerateIds:false, save:true, maxDepth: 5 });
                    }catch(err){
                      // If depth prevented the insert, show a toast and abort the fallback to avoid violating constraints
                      if(err && err.message && (err.message.toLowerCase().includes('max depth') || err.message.includes('Maximum depth limit exceeded'))){
                        try{ showToast('목록 최대 깊이(5)를 초과하여 항목을 추가할 수 없습니다.', { variant:'warn' }); }catch(e){}
                        return;
                      }
                      console.warn('insert dropped result failed', err);
                      tryInsertAtIndex(targetParentId, idx, node);
                    }
                  } else {
                    tryInsertAtIndex(targetParentId, idx, node);
                  }
                  try{ renderSidebar(); renderListContents(); }catch(e){}
                }catch(e){ console.warn('insert dropped result failed', e); }
              });
            } else {
              // queue the append-with-dup-check operation as well
              await enqueueOperation(async ()=>{ await addNodeToParentWithDupCheck(targetParentId, node); try{ saveLists(); renderSidebar(); renderListContents(); }catch(e){} });
            }
          }catch(err){ console.warn('failed to parse dropped resultData', err); }
          u.dataset.dropIndex = '';
          u.querySelectorAll('.drop-before, .drop-after').forEach(el=> el.classList.remove('drop-before','drop-after'));
          return;
        }
      }catch(e){ /* ignore getData exceptions on some browsers */ }
  // accept typed id first, fallback to plain text
  let draggedId = '';
  try{ draggedId = e.dataTransfer.getData('text/x-list-id') || e.dataTransfer.getData('text/plain') || ''; }catch(e){ draggedId = e.dataTransfer.getData('text/plain') || ''; }
      if(!draggedId) {
        console.log('❌ DROP FAILED: No draggedId found');
        return;
      }
  
  console.log('🔥 DROP EVENT:', { draggedId, targetParentId, idx });
  psDebug('[drop] draggedId=', draggedId, 'targetParentId=', targetParentId, 'idx=', idx);
      try{ psDebug('[drop] beforeMove', { draggedId, targetParentId, idx, origParentId: findParentId(state.userLists, draggedId), depth: findNodeDepth(state.userLists, draggedId) }); }catch(e){}
      // capture snapshot before move
      let beforeSnap = null;
      try{ beforeSnap = snapshotForNode(draggedId); psDebug('[drop] snapshotBefore', beforeSnap); }catch(e){ }
      
      console.log('🔍 DROP: checking idx =', idx, 'Number.isNaN(idx) =', Number.isNaN(idx));
      
      if(Number.isNaN(idx)){
        console.log('🔥 Taking moveNode path (NaN index)');
        try{ 
          await enqueueOperation(async ()=> {
            await moveNode(draggedId, targetParentId);
            // 🔄 CRITICAL: 드래그 앤 드롭 완료 후 ListCore 상태 즉시 동기화
            if(window.ListCore) {
              window.ListCore.state.lists = JSON.parse(JSON.stringify(state.userLists));
              console.log('✅ ListCore state synced after moveNode');
            }
            // 명시적으로 저장 보장
            try{ 
              await saveLists(); 
              console.log('✅ saveLists after moveNode completed');
            }catch(e){ console.warn('saveLists after moveNode failed', e); }
            // UI 업데이트
            try{
              renderSidebar(); 
              renderListContents();
              console.log('✅ UI updated after moveNode');
            }catch(e){ console.warn('UI update after moveNode failed', e); }
            // 다른 윈도우에 변경사항 알림
                try{ 
                  if(typeof BroadcastChannel !== 'undefined'){ 
                    const bc = new BroadcastChannel('paperscout-sync'); 
                    bc.postMessage({ type: 'userLists-updated', sender: APP_WINDOW_ID }); 
                    bc.close(); 
                  } 
                }catch(e){ console.warn('broadcast failed', e); }
          }); 
        }catch(err){ console.error(err); }
      } else {
        console.log('🔥 Taking moveNodeToIndex path (index =', idx, ')');
        try{ 
          await enqueueOperation(async ()=> {
            await moveNodeToIndex(draggedId, targetParentId, idx);
            // 🔄 CRITICAL: 드래그 앤 드롭 완료 후 ListCore 상태 즉시 동기화
            if(window.ListCore) {
              window.ListCore.state.lists = JSON.parse(JSON.stringify(state.userLists));
              console.log('✅ ListCore state synced after moveNodeToIndex');
            }
            // 명시적으로 저장 보장
            try{ 
              await saveLists(); 
              console.log('✅ saveLists after moveNodeToIndex completed');
            }catch(e){ console.warn('saveLists after moveNodeToIndex failed', e); }
            // UI 업데이트
            try{
              renderSidebar(); 
              renderListContents();
              console.log('✅ UI updated after moveNodeToIndex');
            }catch(e){ console.warn('UI update after moveNodeToIndex failed', e); }
            // 다른 윈도우에 변경사항 알림
                try{ 
                  if(typeof BroadcastChannel !== 'undefined'){ 
                    const bc = new BroadcastChannel('paperscout-sync'); 
                    bc.postMessage({ type: 'userLists-updated', sender: APP_WINDOW_ID }); 
                    bc.close(); 
                  } 
                }catch(e){ console.warn('broadcast failed', e); }
          }); 
        }catch(err){ console.error(err); }
      }
      // capture snapshot after move
      try{ const afterSnap = snapshotForNode(draggedId); psDebug('[drop] snapshotAfter', { before: beforeSnap, after: afterSnap }); }catch(e){ }
      u.dataset.dropIndex = '';
      u.querySelectorAll('.drop-before, .drop-after').forEach(el=> el.classList.remove('drop-before','drop-after'));
    });
  });
}

/* bookmarks and recent functionality removed */

// static tabs removed

// Insert a dropped PDF file as a new pdf node under parentId at optional index
async function insertPdfNodeAt(parentId, file, index){
  if(!file) throw new Error('no-file');
  const fileId = crypto.randomUUID();
  // compute content signature to help dedupe across insertion flows
  let fileSignature = null;
  try{ fileSignature = await hashBlob(file); }catch(e){ console.warn('hashBlob failed before insert', e); }
  try{ await dbPutFile(fileId, file); }catch(e){ console.warn('dbPutFile failed', e); }
  const pdfNode = { id: crypto.randomUUID(), name: file.name || '문서.pdf', fileId, fileSignature: fileSignature || null, type: 'pdf', children: [] };
    if(typeof index === 'undefined' || index === null){
      // append via dup-checking helper
      logInsertEvent('attempt-insert', { path: 'append', parentId, nodeId: pdfNode.id, fileId: pdfNode.fileId, signature: pdfNode.fileSignature });
      await addNodeToParentWithDupCheck(parentId, pdfNode);
    } else {
      // insert at specific index: perform duplicate pre-check (covers legacy nodes lacking signatures)
      try{
        // ensure signature present on new node when possible
        try{
          if(!pdfNode.fileSignature && pdfNode.fileId){ const b = await dbGetFile(pdfNode.fileId); if(b){ const s = await hashBlob(b); if(s) pdfNode.fileSignature = s; } }
        }catch(e){ /* ignore */ }
        // quick checks
        if(pdfNode.remoteUrl && findNodeByRemoteUrl(state.userLists, pdfNode.remoteUrl)){
          showToast('이미 동일한 문서가 목록에 있습니다. 중복 추가를 건너뜁니다.', { variant:'warn' });
          return;
        }
        if(pdfNode.fileId && findNodeByFileId(state.userLists, pdfNode.fileId)){
          showToast('이미 동일한 문서가 목록에 있습니다. 중복 추가를 건너뜁니다.', { variant:'warn' });
          return;
        }
        if(pdfNode.fileSignature){
          const found = findNodeByFileSignature(state.userLists, pdfNode.fileSignature);
          if(found){ showToast('이미 동일한 문서가 목록에 있습니다. 중복 추가를 건너뜁니다.', { variant:'warn' }); return; }
          // async on-the-fly scan to compute missing signatures in existing nodes
          try{ const fnd = await findNodeByFileSignatureAsync(state.userLists, pdfNode.fileSignature); if(fnd){ showToast('이미 동일한 문서가 목록에 있습니다. 중복 추가를 건너뜁니다.', { variant:'warn' }); return; } }catch(e){ /* ignore */ }
        }
        // proceed with insertion at index
        logInsertEvent('attempt-insert', { path: 'insertAtIndex', parentId, index, nodeId: pdfNode.id, fileId: pdfNode.fileId, signature: pdfNode.fileSignature });
        tryInsertAtIndex(parentId, index, pdfNode);
      }catch(e){ console.warn('insertPdfNodeAt: insertAtIndex failed', e); }
    }
  // optionally auto-upload
  try{
    const ep = localStorage.getItem('uploadEndpoint');
    const auto = localStorage.getItem('autoUpload') === 'true';
    if(ep && auto){ uploadBlobToServer(fileId, pdfNode, ep).catch(e=> console.warn('uploadBlobToServer failed', e)); }
  }catch(e){ console.warn('upload-settings-read-failed', e); }
}

// Open a PDF node in the viewer. Prefer local Blob (IndexedDB) and show via iframe
// so the browser's native PDF renderer is used. If no local blob is present,
// fall back to using node.remoteUrl (if available). Keeps the viewer inline on
// the main page instead of using the canvas/PDF.js viewer.
async function openPdfNode(node){
  if(!node) throw new Error('no-node');
  try{
    // revoke any previous object URL
    if(window._currentPdfObjectUrl){ try{ URL.revokeObjectURL(window._currentPdfObjectUrl); }catch(e){} window._currentPdfObjectUrl = null; }

    let src = null;
    if(node.fileId){
      const blob = await dbGetFile(node.fileId);
      if(blob){
        try{
          src = URL.createObjectURL(blob);
          window._currentPdfObjectUrl = src;
          // don't eagerly convert the blob to a large data: URL (this can block the main thread)
          // instead create a data URL only if the blob: navigation fails (see onErr below)
        }catch(e){ console.warn('createObjectURL failed', e); }
      }
    }
    // if we don't have a local blob, try remote url
    if(!src && node.remoteUrl){
      try{
        const remoteUrl = String(node.remoteUrl);
        const remoteOrigin = new URL(remoteUrl).origin;
        const pageOrigin = location.origin;
        if(remoteOrigin !== pageOrigin){
          // prefer proxy through configured uploadEndpoint if available, otherwise default to localhost:5001
          const uploadEp = localStorage.getItem('uploadEndpoint') || 'http://localhost:5001';
          let proxyBase = uploadEp;
          try{ proxyBase = new URL(uploadEp).origin; }catch(e){ /* leave as-is */ }
          proxyBase = proxyBase.replace(/\/$/, '');
          src = `${proxyBase}/proxy?url=${encodeURIComponent(remoteUrl)}`;
        } else {
          src = remoteUrl;
        }
      }catch(e){
        src = node.remoteUrl;
      }
    }
    if(!src) throw new Error('pdf-data-not-found');

    // show UI and set iframe source
    if(els.pdfName) els.pdfName.textContent = node.name || node.title || '문서';
    if(els.pdfSection) els.pdfSection.hidden = false;
    if(els.pdfFrame){
      // If src is a blob: URL we set it first. In environments that block blob loads
      // (origin mismatch), fall back to a data: URL if available.
      const setSrc = (s)=>{ try{ els.pdfFrame.src = s; }catch(e){ console.warn('setting iframe.src failed', e); } };
      setSrc(src);
      if((src||'').startsWith('blob:')){
        // watch for an error event and then try data: URL fallback (if prepared)
        const onErr = async ()=>{
          try{ els.pdfFrame.removeEventListener('error', onErr); }catch(e){}
          // If we previously prepared a data URL, use it
          const dataUrl = window._currentPdfDataUrl || null;
          if(dataUrl){ setSrc(dataUrl); return; }
          // Lazily convert the blob to a data URL only when needed to avoid main-thread jank
          try{
            if(typeof blob !== 'undefined' && blob){
              const fr = new FileReader();
              fr.onload = ()=>{ try{ setSrc(String(fr.result)); }catch(e){ console.warn('setting dataUrl failed', e); } };
              fr.onerror = ()=>{ console.warn('dataUrl conversion failed'); };
              fr.readAsDataURL(blob);
            }
          }catch(e){ console.warn('data url creation failed', e); }
        };
        // set a short timeout to check fallback if error doesn't fire promptly
        els.pdfFrame.addEventListener('error', onErr);
        setTimeout(()=>{
          // if iframe still hasn't navigated (still about:blank or same src), attempt lazy fallback
          const cur = els.pdfFrame.src || '';
          if(cur === src){ try{ onErr(); }catch(e){ console.warn('fallback onErr failed', e); } }
        }, 400);
      }
      // focus iframe for keyboard access (best-effort)
      try{ els.pdfFrame.focus(); }catch(e){}
    }
  }catch(err){
    console.error('openPdfNode error', err);
    showToast('PDF를 열 수 없습니다. (로컬 파일 또는 원격 URL을 확인하세요)', { variant: 'error' });
    throw err;
  }
}

function closePdfViewer(){
  try{
    if(els.pdfFrame){
      // clear src and revoke any created object URL
      if(window._currentPdfObjectUrl){ try{ URL.revokeObjectURL(window._currentPdfObjectUrl); }catch(e){} window._currentPdfObjectUrl = null; }
      try{ els.pdfFrame.src = 'about:blank'; }catch(e){}
    }
    if(els.pdfSection) els.pdfSection.hidden = true;
  }catch(e){ console.warn('closePdfViewer failed', e); }
}

/* ---------- IndexedDB persistence (simple key/value store) ---------- */
function openDB(){
  return new Promise((res, rej)=>{
    // bump DB version so we can create a separate 'files' store for blobs
    const req = indexedDB.open('paperscout', 2);
    req.onupgradeneeded = ()=>{ const db = req.result; if(!db.objectStoreNames.contains('kv')) db.createObjectStore('kv'); if(!db.objectStoreNames.contains('files')) db.createObjectStore('files'); };
    req.onsuccess = ()=> res(req.result);
    req.onerror = ()=> rej(req.error);
  });
}

async function dbPut(key, value){
  const db = await openDB();
  return new Promise((res, rej)=>{
    const tx = db.transaction('kv', 'readwrite');
    const store = tx.objectStore('kv');
    const rq = store.put(value, key);
    rq.onsuccess = ()=>{ tx.oncomplete = ()=>{ db.close(); res(true); }; };
    rq.onerror = ()=>{ db.close(); rej(rq.error); };
  });
}

async function dbGet(key){
  const db = await openDB();
  return new Promise((res, rej)=>{
    const tx = db.transaction('kv', 'readonly');
    const store = tx.objectStore('kv');
    const rq = store.get(key);
    rq.onsuccess = ()=>{ db.close(); res(rq.result); };
    rq.onerror = ()=>{ db.close(); rej(rq.error); };
  });
}

// files store helpers (Blobs)
async function dbPutFile(key, blob){
  const db = await openDB();
  return new Promise((res, rej)=>{
    const tx = db.transaction('files', 'readwrite');
    const store = tx.objectStore('files');
    const rq = store.put(blob, key);
    rq.onsuccess = ()=>{ tx.oncomplete = ()=>{ db.close(); res(true); }; };
    rq.onerror = ()=>{ db.close(); rej(rq.error); };
  });
}

// Compute a stable content signature for a Blob using SHA-1 (short and sufficient for dedupe)
async function hashBlob(blob){
  try{
    const ab = await blob.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-1', ab);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hex = hashArray.map(b => b.toString(16).padStart(2,'0')).join('');
    return hex;
  }catch(e){
    console.warn('hashBlob failed', e);
    return null;
  }
}

// Migrate existing userLists: compute fileSignature for PDF nodes that have a fileId but no fileSignature.
// This will read the blob from IndexedDB and compute a SHA-1 signature, then persist lists.
async function migrateFillFileSignatures(){
  try{
    // run once only
    if(localStorage.getItem('fileSignatureMigration') === 'done') return { ok:true, skipped:true };
    // gather targets
    const targets = [];
    const skippedIds = []; // collect fileIds (or node ids) that were skipped so we can report them
    function collect(n){
      if(!n) return;
      if(n.type === 'pdf'){
        if(n.fileId && !n.fileSignature) targets.push(n);
        return;
      }
      if(Array.isArray(n.children)) for(const c of n.children) collect(c);
    }
    if(Array.isArray(state.userLists)) for(const top of state.userLists) collect(top);
    if(!targets.length){
      // mark as done to avoid re-running
      try{ localStorage.setItem('fileSignatureMigration', 'done'); }catch(e){}
      return { ok:true, updated:0 };
    }
    showToast(`파일 시그니처 마이그레이션 시작: ${targets.length}개 항목 처리 중...`, { variant:'info', timeout: 4000 });
    let updated = 0; let skipped = 0; let failed = 0;
    for(const node of targets){
      try{
        const blob = await dbGetFile(node.fileId);
        if(!blob){ skipped++; try{ skippedIds.push(node.fileId || node.id); }catch(e){} continue; }
        const sig = await hashBlob(blob);
        if(sig){ node.fileSignature = sig; updated++; }
        else { skipped++; }
      }catch(e){ console.warn('migrateFillFileSignatures: item failed', e); failed++; }
    }
    if(updated > 0){
      try{ await saveLists(); }catch(e){ console.warn('migrate: saveLists failed', e); }
      try{ const cur = (await dbGet('userListsVersion')) || 0; await dbPut('userListsVersion', Number(cur) + 1); }catch(e){ /* non-fatal */ }
    }
    // persist skip report for diagnostics
    try{ await dbPut('migrationSkippedFileIds', skippedIds); }catch(e){ console.warn('failed to persist migration skip report', e); }
    try{ localStorage.setItem('fileSignatureMigration', 'done'); }catch(e){}
    showToast(`마이그레이션 완료: ${updated}개 업데이트, ${skipped}개 누락, ${failed}개 실패`, { variant:'info' });
    if(skippedIds && skippedIds.length){ console.info('[migration-skip-report] skipped fileIds=', skippedIds); }
    return { ok:true, updated, skipped, failed, skippedIds };
  }catch(e){ console.warn('migrateFillFileSignatures failed', e); showToast('파일 시그니처 마이그레이션 중 오류가 발생했습니다.', { variant:'error' }); return { ok:false, error: String(e) }; }
}

// Clean duplicate nodes in state.userLists (and persist).
// Merge rules (implemented):
// 1) Group nodes by key = fileSignature || remoteUrl || fileId || id
// 2) For each group having >1 node, pick a canonical node using these preferences:
//    - Prefer a node with remoteUrl (and uploadedAt most recent)
//    - Else prefer a node with fileSignature and/or fileId
//    - Else pick the node with the most recent uploadedAt, or first encountered
// 3) Merge metadata into the kept node: name, remoteUrl, fileId, fileSignature,
//    uploadStatus (prioritize 'uploaded' > 'uploading' > 'failed' > undefined),
//    uploadProgress (max), uploadedAt (latest)
// 4) Remove the other nodes from lists (do not auto-delete blobs)
// Returns a report { groupsProcessed, removedIds, keptIds }
async function cleanDuplicateRecords({ deleteOrphanBlobs = false } = {}){
  const report = { groupsProcessed: 0, removedIds: [], keptIds: [], details: [] };
  try{
    // flatten all pdf nodes with parent info
    const nodes = [];
    function collect(lists){
      for(const n of lists){
        if(n.type === 'pdf'){ nodes.push(n); }
        if(n.children && n.children.length) collect(n.children);
      }
    }
    collect(state.userLists || []);

    // group by key
    const groups = new Map();
    for(const n of nodes){
      const key = n.fileSignature || n.remoteUrl || n.fileId || n.id;
      const k = String(key || n.id);
      if(!groups.has(k)) groups.set(k, []);
      groups.get(k).push(n);
    }

    for(const [k, arr] of groups){
      if(!arr || arr.length < 2) continue;
      report.groupsProcessed++;
      // choose canonical node
      const pick = (()=>{
        // prefer remoteUrl + latest uploadedAt
        const withRemote = arr.filter(x=>x.remoteUrl);
        if(withRemote.length){
          withRemote.sort((a,b)=>{ const ta = a.uploadedAt ? Date.parse(a.uploadedAt) : 0; const tb = b.uploadedAt ? Date.parse(b.uploadedAt) : 0; return tb - ta; });
          return withRemote[0];
        }
        // prefer any with fileSignature or fileId
        const withFile = arr.filter(x=>x.fileSignature || x.fileId);
        if(withFile.length){
          // prioritize uploaded status
          withFile.sort((a,b)=>{
            const prio = s => s === 'uploaded' ? 3 : (s === 'uploading' ? 2 : (s === 'failed' ? 1 : 0));
            const pa = prio(a.uploadStatus), pb = prio(b.uploadStatus);
            if(pa !== pb) return pb - pa;
            const ta = a.uploadedAt ? Date.parse(a.uploadedAt) : 0;
            const tb = b.uploadedAt ? Date.parse(b.uploadedAt) : 0;
            return tb - ta;
          });
          return withFile[0];
        }
        // fallback: pick most recently uploadedAt or first
        arr.sort((a,b)=>{ const ta = a.uploadedAt ? Date.parse(a.uploadedAt) : 0; const tb = b.uploadedAt ? Date.parse(b.uploadedAt) : 0; return tb - ta; });
        return arr[0];
      })();

      const toRemove = arr.filter(n => n.id !== pick.id);
      // merge metadata into pick
      try{
        for(const other of toRemove){
          // name: prefer non-empty
          if((!pick.name || pick.name === '문서') && other.name) pick.name = other.name;
          // remoteUrl, fileId, fileSignature
          if(!pick.remoteUrl && other.remoteUrl) pick.remoteUrl = other.remoteUrl;
          if(!pick.fileId && other.fileId) pick.fileId = other.fileId;
          if(!pick.fileSignature && other.fileSignature) pick.fileSignature = other.fileSignature;
          // uploadStatus priority: uploaded > uploading > failed > undefined
          const prio = s => s === 'uploaded' ? 3 : (s === 'uploading' ? 2 : (s === 'failed' ? 1 : 0));
          if(prio(other.uploadStatus) > prio(pick.uploadStatus)) pick.uploadStatus = other.uploadStatus;
          // uploadProgress: keep max known
          try{ if((other.uploadProgress||0) > (pick.uploadProgress||0)) pick.uploadProgress = other.uploadProgress; }catch(_){}
          // uploadedAt: keep latest
          try{ if(other.uploadedAt && (!pick.uploadedAt || Date.parse(other.uploadedAt) > Date.parse(pick.uploadedAt))) pick.uploadedAt = other.uploadedAt; }catch(_){}
        }
      }catch(e){ console.warn('merge metadata failed', e); }

      // remove duplicate nodes from state.userLists
      for(const rem of toRemove){
        try{
          const found = findAndRemoveNode(state.userLists, rem.id);
          if(found){ report.removedIds.push(rem.id); }
        }catch(e){ console.warn('failed to remove duplicate node', rem.id, e); }
      }
      report.keptIds.push(pick.id);
      report.details.push({ key:k, kept: pick.id, removed: toRemove.map(x=>x.id) });
    }

    // persist and return
    try{ await saveLists(); }catch(e){ console.warn('saveLists after dedupe failed', e); }
    console.info('[cleanDuplicateRecords] report=', report);
    return report;
  }catch(e){ console.warn('cleanDuplicateRecords failed', e); return { ok:false, error: String(e) }; }
}

// Expose for console usage
window.cleanDuplicateRecords = cleanDuplicateRecords;

// Utility: retrieve persisted migration skip report
async function getMigrationSkipReport(){
  try{ const v = await dbGet('migrationSkippedFileIds'); return Array.isArray(v)? v : (v? [v]: []); }catch(e){ console.warn('getMigrationSkipReport failed', e); return []; }
}

async function dbGetFile(key){
  const db = await openDB();
  return new Promise((res, rej)=>{
    const tx = db.transaction('files', 'readonly');
    const store = tx.objectStore('files');
    const rq = store.get(key);
    rq.onsuccess = ()=>{ db.close(); res(rq.result); };
    rq.onerror = ()=>{ db.close(); rej(rq.error); };
  });
}

// --- Sync status UI helper -------------------------------------------------
function setSyncStatus(stateStr, message){
  try{
    const badge = document.getElementById('syncStatusBadge');
    if(!badge) return;
    badge.className = 'sync-badge';
    if(stateStr === 'syncing'){
      badge.classList.add('sync-badge--syncing'); badge.textContent = message || '동기화 중…';
    } else if(stateStr === 'success'){
      badge.classList.add('sync-badge--success'); badge.textContent = message || '동기화 성공';
      // fade back to idle after short delay
      setTimeout(()=>{ try{ badge.className='sync-badge sync-badge--idle'; badge.textContent='동기화됨'; }catch(_){ } }, 3000);
    } else if(stateStr === 'error'){
      badge.classList.add('sync-badge--error'); badge.textContent = message || '동기화 실패';
      // keep visible until next action
    } else {
      badge.classList.add('sync-badge--idle'); badge.textContent = message || '동기화 없음';
    }
  }catch(e){ console.warn('setSyncStatus failed', e); }
}

async function saveLists(){
  console.log('🔥 SAVE LISTS: Starting save operation...');
  console.log('🔍 Current state.userLists:', state.userLists ? state.userLists.length : 'null/undefined');
  
  // Prefer centralized ListCore if available
  try{
    if(window.ListCore && typeof window.ListCore.saveLists === 'function'){
      console.log('📤 Using ListCore.saveLists...');
      const res = await window.ListCore.saveLists(state.userLists);
      if(!res || !res.ok) {
        console.warn('ListCore.saveLists reported failure', res);
      } else {
        console.log('✅ ListCore.saveLists completed successfully');
      }
      return;
    } else {
      console.log('⚠️ ListCore not available, falling back to direct IndexedDB');
    }
  }catch(e){ console.warn('ListCore.saveLists failed', e); }
  
  // If user is authenticated, prefer server-side save with fallback to IndexedDB
  try{
    const token = localStorage.getItem('paperscout_auth_token');
    // indicate sync start
    if(token) setSyncStatus('syncing');
    if(token){
      console.log('📡 Attempting server-side save for authenticated user');
      try{
        const r = await fetch('/api/user/lists', { method: 'POST', headers: { 'Content-Type':'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify({ lists: state.userLists }), });
        if(r.ok){ console.log('✅ Server-side save completed'); return; }
        console.warn('Server save responded with', r.status);
        setSyncStatus('error', `서버 오류 ${r.status}`);
      }catch(e){ console.warn('Server-side save failed', e); }
    }
    console.log('💾 Saving to IndexedDB directly (fallback)...');
    await dbPut('userLists', state.userLists);
    console.log('✅ Direct IndexedDB save completed');
    // local save counts as success for the user
    setSyncStatus('success');
  }catch(e){ console.warn('saveLists failed', e); }
}

async function loadLists(){
  // Prefer centralized ListCore if available
  try{
    if(window.ListCore && typeof window.ListCore.loadLists === 'function'){
      const res = await window.ListCore.loadLists();
      // 🔍 Deep copy로 중첩된 자식목록까지 보존
      const lists = Array.isArray(res.lists) ? res.lists : (res || []).lists || [];
      state.userLists = JSON.parse(JSON.stringify(lists));
      console.log('🔄 loadLists: ListCore data loaded with deep copy');
      if(!state.selectedListId && state.userLists && state.userLists.length){ state.selectedListId = findFirstId(state.userLists); }
      return;
    }
  }catch(e){ console.warn('ListCore.loadLists failed', e); }
  // If authenticated, try server first, then fallback to IndexedDB
  try{
    const token = localStorage.getItem('paperscout_auth_token');
    if(token){
      try{
        const r = await fetch('/api/user/lists', { headers: { 'Authorization': `Bearer ${token}` } });
        if(r.ok){ const data = await r.json(); if(data && data.lists){ state.userLists = JSON.parse(JSON.stringify(data.lists)); console.log('🔄 loadLists: loaded from server'); if(!state.selectedListId && state.userLists && state.userLists.length) state.selectedListId = findFirstId(state.userLists); return; } }
        console.warn('Server load responded with', r.status);
      }catch(e){ console.warn('Server-side load failed', e); }
    }
    const data = await dbGet('userLists');
    if(Array.isArray(data)){
      state.userLists = JSON.parse(JSON.stringify(data));
      console.log('🔄 loadLists: IndexedDB data loaded with deep copy');
    }
    if(!state.selectedListId && state.userLists && state.userLists.length){ state.selectedListId = findFirstId(state.userLists); }
  }catch(e){ console.warn('loadLists failed', e); }
}


// NOTE: list card click handling is set up inside renderListContents()

function addList(name, parentId){
  const n = (name||'').trim(); if(!n) return;
  
  console.log('🔥 ADD LIST START:', { name: n, parentId });
  console.log('🔥 Current state.userLists before add:', JSON.stringify(state.userLists, null, 2));
  
  // 🔥 ListCore 사용 우선, fallback은 나중에
  if (window.ListCore && typeof window.ListCore.addList === 'function') {
    console.log('🔥 Using ListCore.addList for:', n, 'parentId:', parentId);
    try {
      window.ListCore.addList(n, parentId);
      console.log('✅ ListCore.addList completed');
      
      // 상태 동기화 확인
      console.log('🔥 ListCore.state.lists after add:', JSON.stringify(window.ListCore.state.lists, null, 2));
      
      // ListCore에서 stateChanged 이벤트로 UI가 자동 업데이트되지만, 
      // 안전을 위해 수동으로도 UI 업데이트 실행
      setTimeout(() => {
        console.log('🔥 Manual UI update triggered');
        renderSidebar();
        renderListContents();
      }, 50);
      return;
    } catch (e) {
      console.warn('ListCore.addList failed, falling back to manual:', e);
    }
  }
  
  // Fallback: 수동 처리
  console.log('🔄 Manual addList fallback');
  const id = crypto.randomUUID();
  const node = { id, name: n, children: [] };
    if(!parentId) {
      // Use the centralized helper which will fallback if needed
      state.selectedListId = id;
      els.newListName.value = '';
      // 방어적 코드 추가: state.userLists가 배열인지 확인
      if (!Array.isArray(state.userLists)) {
        state.userLists = [];
      }
      tryInsertAtIndex(null, state.userLists.length, node);
      // 직접 저장 시도
      saveLists().catch(e => console.warn('Failed to save lists:', e));
      // UI 업데이트 추가
      renderSidebar();
      renderListContents();
      return;
  } else {
    // enforce max depth before attempting to append
    try{
      const pd = findNodeDepth(state.userLists, parentId);
      if(typeof pd === 'number' && pd >= MAX_LIST_DEPTH){
        showToast('하위 목록을 추가할 수 없습니다: 최대 깊이(5)에 도달했습니다.', { variant:'warn' });
        return;
      }
    }catch(e){ /* ignore */ }
    const appended = appendChildToParent(state.userLists, parentId, node);
    if(!appended) return; // parent not found
    state.selectedListId = id;
    els.newListName.value = '';
    renderSidebar();
    saveLists();
    renderListContents();
  }
}

function appendChildToParent(lists, parentId, node){
  try{ if(window.ListCore && typeof window.ListCore.appendChildToParent === 'function') return window.ListCore.appendChildToParent(lists, parentId, node); }catch(e){ console.warn('ListCore.appendChildToParent failed', e); }
  // fallback to local implementation (preserve previous behavior)
  // Defensive guard: avoid inserting a node into its own descendant (would create cycles)
  try{ if(parentId && node && node.id && isDescendant(node.id, parentId)){ console.warn('appendChildToParent prevented: parentId is a descendant of node', { parentId, nodeId: node.id }); try{ showToast('작업 취소: 항목을 자신의 하위로 이동할 수 없습니다.', { variant:'warn' }); }catch(_){ } return false; } }catch(e){}
  const toInsert = node ? JSON.parse(JSON.stringify(node)) : node;
  try{ if(parentId){ const pd = findNodeDepth(state.userLists, parentId); if(typeof pd === 'number' && pd >= MAX_LIST_DEPTH && toInsert && toInsert.type !== 'pdf'){ try{ showToast('하위 목록을 추가할 수 없습니다: 최대 깊이(5)에 도달했습니다.', { variant:'warn' }); }catch(_){ } return false; } } }catch(e){}
  for(const l of lists){
    if(l.id === parentId){ l.children = l.children || []; l.children.push(toInsert); try{ psDebug('[appendChildToParent] appended', { parentId: l.id, nodeId: toInsert && toInsert.id }); }catch(_){ } return true; }
    if(l.children && l.children.length){ if(appendChildToParent(l.children, parentId, toInsert)){ try{ psDebug('[appendChildToParent] appended-recursive', { parentId, nodeId: toInsert && toInsert.id }); }catch(_){ } return true; } }
  }
  return false;
}

async function deleteList(id){
  console.log('🗑️ DELETE LIST:', id);
  
  try{
    if(window.ListCore && typeof window.ListCore.deleteList === 'function'){
      // 🔄 CRITICAL: 현재 상태를 ListCore에 동기화
      console.log('🔄 BEFORE deleteList: syncing current state to ListCore...');
      window.ListCore.state.lists = JSON.parse(JSON.stringify(state.userLists));
      console.log('✅ Current state synced to ListCore before deleteList');
      
      // Use ListCore's delete method for proper state management
      console.log('🗑️ Using ListCore.deleteList');
      const success = await window.ListCore.deleteList(id);
      if(success) {
        console.log('✅ ListCore.deleteList 성공');
        // Sync app.js state with ListCore
        state.userLists = JSON.parse(JSON.stringify(window.ListCore.state.lists));
        state.selectedListId = window.ListCore.state.selectedId;
        
        renderSidebar(); 
        renderListContents();
        
        // Ensure changes are saved with await
        try {
          await saveLists();
          console.log('✅ saveLists 완료');
        } catch(e) {
          console.warn('saveLists failed', e);
        }
        
        return;
      }
    }
  }catch(e){ 
    console.warn('ListCore.deleteList failed', e); 
  }
  
  // fallback: immutable delete
  console.log('🗑️ Using fallback deleteListById');
  state.userLists = deleteListById(state.userLists, id);
  if(state.selectedListId === id) state.selectedListId = findFirstId(state.userLists);
  
  // Sync ListCore state
  if(window.ListCore) {
    window.ListCore.state.lists = JSON.parse(JSON.stringify(state.userLists));
    window.ListCore.state.selectedId = state.selectedListId;
  }
  
  renderSidebar();
  try {
    await saveLists();
    console.log('✅ Fallback saveLists 완료');
  } catch(e) {
    console.warn('Fallback saveLists failed', e);
  }
  renderListContents();
}

function deleteListById(lists, id){
  const out = [];
  for(const l of lists){
    if(l.id === id) continue;
    const copy = {...l};
    if(copy.children && copy.children.length){ copy.children = deleteListById(copy.children, id); }
    out.push(copy);
  }
  return out;
}

function findFirstId(lists){
  if(!lists || !lists.length) return null;
  return lists[0].id || findFirstId(lists[0].children || []);
}

// Find the depth (1-based) of a node by id. Returns null if not found.
function findNodeDepth(lists, id){
  try{ if(window.ListCore && typeof window.ListCore.getDepthById === 'function') return window.ListCore.getDepthById(lists, id); }catch(e){ console.warn('ListCore.getDepthById failed', e); }
  // fallback: local traversal
  function walk(arr, depth){
    if(!arr || !arr.length) return null;
    for(const l of arr){
      if(l.id === id) return depth;
      if(l.children && l.children.length){
        const d = walk(l.children, depth+1);
        if(d) return d;
      }
    }
    return null;
  }
  return walk(lists, 1);
}

// Find the parent id of a node (returns null if top-level or not found)
function findParentId(lists, id){
  try{ if(window.ListCore && typeof window.ListCore.findParentId === 'function') return window.ListCore.findParentId(id, lists); }catch(e){ console.warn('ListCore.findParentId failed', e); }
  if(!lists || !lists.length) return null;
  for(const l of lists){
    if(l.id === id) return null;
    if(l.children && l.children.length){
      for(const c of l.children){ if(c.id === id) return l.id; }
      const deeper = findParentId(l.children, id);
      if(deeper) return deeper;
    }
  }
  return null;
}

// selectList: mark selected list and render its contents
// Coalesced render: schedule renderSidebar/renderListContents on next animation frame
let _renderScheduled = false;
function scheduleRender(){
  if(_renderScheduled) return;
  _renderScheduled = true;
  requestAnimationFrame(()=>{
    try{ renderSidebar(); renderListContents(); }catch(e){ console.warn('scheduled render failed', e); }
    _renderScheduled = false;
  });
}

function selectList(id){ state.selectedListId = id; scheduleRender(); }

// Simple operation queue to serialize list mutations (prevent concurrent moves/inserts)
// Ensures drop handlers and other high-level mutations run one-at-a-time to avoid
// races that can result in accidental parent/sibling moves.
const _opQueue = [];
let _opRunning = false;
function enqueueOperation(fn){
  console.log('🔥 ENQUEUE OPERATION: Adding operation to queue');
  return new Promise((res, rej)=>{
    console.log('🔥 ENQUEUE OPERATION: Creating promise, adding to queue');
    _opQueue.push({ fn, res, rej });
    console.log('🔥 ENQUEUE OPERATION: Queue length =', _opQueue.length);
    // kick the processor
    setTimeout(processOpQueue, 0);
    console.log('🔥 ENQUEUE OPERATION: processOpQueue scheduled');
  });
}
async function processOpQueue(){
  console.log('🔥 PROCESS OP QUEUE: Called, _opRunning =', _opRunning, 'queue length =', _opQueue.length);
  if(_opRunning) {
    console.log('🔥 PROCESS OP QUEUE: Already running, returning');
    return;
  }
  const item = _opQueue.shift();
  if(!item) {
    console.log('🔥 PROCESS OP QUEUE: No items in queue, returning');
    return;
  }
  console.log('🔥 PROCESS OP QUEUE: Processing item, setting _opRunning = true');
  _opRunning = true;
  try{
    console.log('🔥 PROCESS OP QUEUE: Executing operation function...');
    const r = await item.fn();
    console.log('🔥 PROCESS OP QUEUE: Operation completed successfully');
    try{ item.res(r); }catch(_){ }
  }catch(e){ 
    console.error('🔥 PROCESS OP QUEUE: Operation failed:', e);
    try{ item.rej(e); }catch(_){ } 
  }
  _opRunning = false;
  console.log('🔥 PROCESS OP QUEUE: Setting _opRunning = false, scheduling next');
  // process next
  setTimeout(processOpQueue, 0);
}



function findListByName(lists, name){
  for(const l of lists){
    if(l.name === name) return l;
    if(l.children && l.children.length){
      const found = findListByName(l.children, name);
      if(found) return found;
    }
  }
  return null;
}

function findNodeById(lists, id){
  if(window.ListCore && typeof window.ListCore.findNodeById === 'function') return window.ListCore.findNodeById(lists, id);
  console.error('ListCore.findNodeById is required but missing');
  return null;
}

function findNodeByRemoteUrl(lists, url){
  if(window.ListCore && typeof window.ListCore.findNodeByRemoteUrl === 'function') return window.ListCore.findNodeByRemoteUrl(lists, url);
  console.error('ListCore.findNodeByRemoteUrl is required but missing');
  return null;
}

// Helper: try centralized insertAtIndex, fallback to synchronous insertion and save/render
function tryInsertAtIndex(parentId, index, node, cb){
  // 방어적 상태 체크 추가
  if (!Array.isArray(state.userLists)) {
    state.userLists = [];
  }
  
  // Defensive guard: if the node appears to be a duplicate according to our
  // duplicate-detection logic, skip insertion entirely. This prevents some
  // double-insert cases where multiple insertion paths race or are both
  // invoked for the same logical item.
  try{
    if(isDuplicateNode(node)){
      logInsertEvent('skip-insert-duplicate', { parentId, index, nodeId: node && node.id, fileId: node && node.fileId, signature: node && node.fileSignature });
      try{ if(cb) cb(); }catch(e){}
      return;
    }
  }catch(e){ /* ignore detection errors and continue to attempt insert */ }
  try{
    // Prevent inserting a node into its own descendant (would create cycles / move parent under child)
    try{
  if(parentId && node && node.id && isDescendant(node.id, parentId)){
        console.warn('Prevented insert: target parent is a descendant of the node (would create cycle)', { nodeId: node.id, parentId });
        try{ showToast('작업 취소: 항목을 자신의 하위로 이동할 수 없습니다.', { variant:'warn' }); }catch(_){ }
        try{ psDebug('[tryInsertAtIndex] prevented-cycle', { nodeId: node.id, parentId }); }catch(_){ }
        try{ if(cb) cb(); }catch(e){}
        return;
      }
    }catch(e){ /* ignore desc check failures */ }
    if(window.ListCore && typeof window.ListCore.insertAtIndex === 'function'){
      window.ListCore.insertAtIndex(state.userLists, parentId, index, node, { clone:false, regenerateIds:false, save:true, maxDepth: 5 })
          .then(()=>{ try{ psDebug('[tryInsertAtIndex] inserted-via-ListCore', { parentId, index, nodeId: node && node.id }); }catch(_){ }
            try{ if(cb) cb(); }catch(e){} })
            .catch(err=>{
              try{
                // If insert was blocked by max-depth, surface a friendly toast and DO NOT perform the fallback insert
                if(err && err.message && (err.message.toLowerCase().includes('max depth') || err.message.includes('Maximum depth limit exceeded'))){
                  console.warn('ListCore.insertAtIndex prevented insertion due to depth limit', err);
                  try{ showToast('작업을 수행할 수 없습니다: 최대 깊이(5)를 초과합니다.', { variant:'warn' }); }catch(e){}
                  try{ if(cb) cb(); }catch(e){}
                  return;
                }
              }catch(e){}
              console.warn('ListCore.insertAtIndex failed in tryInsertAtIndex', err);
              // fallback: avoid inserting duplicates — but perform via operation queue to serialize
              enqueueOperation(async ()=>{
                try{
                  if(isDuplicateNode(node)){
                    try{ showToast('이미 동일한 문서가 목록에 있습니다. 중복 추가를 건너뜁니다.', { variant:'warn' }); }catch(e){}
                  } else {
                    if(!parentId){ const i = Math.max(0, Math.min(index, state.userLists.length)); state.userLists.splice(i, 0, node); }
                    else { const parent = findNodeById(state.userLists, parentId); if(!parent){ const i = Math.max(0, Math.min(index, state.userLists.length)); state.userLists.splice(i, 0, node); } else { parent.children = parent.children || []; const i = Math.max(0, Math.min(index, parent.children.length)); parent.children.splice(i, 0, node); } }
                  }
                }catch(e){ console.warn('fallback insert failed', e); }
                try{ saveLists(); renderSidebar(); renderListContents(); }catch(e){}
              }).then(()=>{ try{ if(cb) cb(); }catch(e){} }).catch(()=>{ try{ if(cb) cb(); }catch(e){} });
            });
      return;
    }
  }catch(e){ console.warn('tryInsertAtIndex ListCore check failed', e); }
  // fallback synchronous insert -> perform via operation queue to serialize
  enqueueOperation(async ()=>{
    try{
      // prevent duplicates on local fallback insert
      if(isDuplicateNode(node)){
        try{ showToast('이미 동일한 문서가 목록에 있습니다. 중복 추가를 건너뜁니다.', { variant:'warn' }); }catch(e){}
      } else {
        if(!parentId){ const i = Math.max(0, Math.min(index, state.userLists.length)); state.userLists.splice(i, 0, node); }
        else { const parent = findNodeById(state.userLists, parentId); if(!parent){ const i = Math.max(0, Math.min(index, state.userLists.length)); state.userLists.splice(i, 0, node); } else { parent.children = parent.children || []; const i = Math.max(0, Math.min(index, parent.children.length)); parent.children.splice(i, 0, node); } }
      }
    }catch(e){ console.warn('tryInsertAtIndex fallback insert failed', e); }
    try{ saveLists(); renderSidebar(); renderListContents(); }catch(e){}
    try{ psDebug('[tryInsertAtIndex] inserted-fallback', { parentId, index, nodeId: node && node.id }); }catch(_){ }
  }).then(()=>{ try{ if(cb) cb(); }catch(e){} }).catch(()=>{ try{ if(cb) cb(); }catch(e){} });
}


function findNodeByFileId(lists, fileId){
  if(window.ListCore && typeof window.ListCore.findNodeByFileId === 'function') return window.ListCore.findNodeByFileId(lists, fileId);
  console.error('ListCore.findNodeByFileId is required but missing');
  return null;
}

function findNodeByFileSignature(lists, signature){
  if(window.ListCore && typeof window.ListCore.findNodeByFileSignature === 'function') return window.ListCore.findNodeByFileSignature(lists, signature);
  console.error('ListCore.findNodeByFileSignature is required but missing');
  return null;
}

function isDuplicateNode(node){
  if(window.ListCore && typeof window.ListCore.isDuplicateNode === 'function') return window.ListCore.isDuplicateNode(state.userLists, node);
  console.error('ListCore.isDuplicateNode is required but missing');
  return false;
}

async function addNodeToParentWithDupCheck(parentId, node){
  try{
    // Ensure the new node has a fileSignature when possible (helps robust dedupe)
    try{
      if(!node.fileSignature && node.fileId){
        const b = await dbGetFile(node.fileId);
        if(b){ const s = await hashBlob(b); if(s) node.fileSignature = s; }
      }
    }catch(e){ console.warn('pre-dedupe signature attempt failed', e); }

    // Synchronous quick-path duplicate checks (fast, avoids I/O)
    if(node.remoteUrl && findNodeByRemoteUrl(state.userLists, node.remoteUrl)){
      logInsertEvent('duplicate-detected', { reason: 'remoteUrl-match', remoteUrl: node.remoteUrl, nodeId: node.id });
      const ok = confirm('이미 동일한 문서가 목록에 있습니다. 중복 추가하시겠습니까? (확인=추가, 취소=취소)');
      if(!ok) { logInsertEvent('duplicate-aborted', { reason: 'remoteUrl-match', nodeId: node.id }); return false; }
      logInsertEvent('duplicate-allowed-by-user', { reason: 'remoteUrl-match', nodeId: node.id });
      return addNodeToParent(parentId, node);
    }
    if(node.fileId && findNodeByFileId(state.userLists, node.fileId)){
      logInsertEvent('duplicate-detected', { reason: 'fileId-match', fileId: node.fileId, nodeId: node.id });
      const ok = confirm('이미 동일한 문서가 목록에 있습니다. 중복 추가하시겠습니까? (확인=추가, 취소=취소)');
      if(!ok) { logInsertEvent('duplicate-aborted', { reason: 'fileId-match', fileId: node.fileId, nodeId: node.id }); return false; }
      logInsertEvent('duplicate-allowed-by-user', { reason: 'fileId-match', fileId: node.fileId, nodeId: node.id });
      return addNodeToParent(parentId, node);
    }

    // If we have a signature for the new node, try a fast in-memory match first.
    if(node.fileSignature){
      if(findNodeByFileSignature(state.userLists, node.fileSignature)){
        logInsertEvent('duplicate-detected', { reason: 'signature-exact-match', signature: node.fileSignature, nodeId: node.id });
        const ok = confirm('이미 동일한 문서가 목록에 있습니다. 중복 추가하시겠습니까? (확인=추가, 취소=취소)');
        if(!ok) { logInsertEvent('duplicate-aborted', { reason: 'signature-exact-match', signature: node.fileSignature, nodeId: node.id }); return false; }
        logInsertEvent('duplicate-allowed-by-user', { reason: 'signature-exact-match', signature: node.fileSignature, nodeId: node.id });
        return addNodeToParent(parentId, node);
      }
      // If no immediate match, perform an async deep-search that computes missing signatures on-the-fly
      try{
        const found = await findNodeByFileSignatureAsync(state.userLists, node.fileSignature);
        if(found){
          logInsertEvent('duplicate-detected', { reason: 'signature-async-match', signature: node.fileSignature, existingNodeId: found.id, nodeId: node.id });
          const ok = confirm('이미 동일한 문서가 목록에 있습니다. 중복 추가하시겠습니까? (확인=추가, 취소=취소)');
          if(!ok) { logInsertEvent('duplicate-aborted', { reason: 'signature-async-match', nodeId: node.id, existingNodeId: found.id }); return false; }
          logInsertEvent('duplicate-allowed-by-user', { reason: 'signature-async-match', nodeId: node.id, existingNodeId: found.id });
          return addNodeToParent(parentId, node);
        }
      }catch(e){ console.warn('async fileSignature scan failed', e); }
    }

    // Fallback: use existing (possibly less precise) duplicate check
    if(isDuplicateNode(node)){
      const ok = confirm('이미 동일한 문서가 목록에 있습니다. 중복 추가하시겠습니까? (확인=추가, 취소=취소)');
      if(!ok) return false;
    }
    // Final defensive check: compute missing signature if possible and perform
    // an async scan to detect duplicates in nodes that previously lacked signatures.
    try{
      if(!node.fileSignature && node.fileId){
        try{ const b = await dbGetFile(node.fileId); if(b){ const s = await hashBlob(b); if(s) node.fileSignature = s; } }catch(e){ /* ignore */ }
      }
      // If we have a signature now, try both fast in-memory and async on-the-fly scan
      if(node.fileSignature){
        const direct = findNodeByFileSignature(state.userLists, node.fileSignature);
        const found = direct || (await findNodeByFileSignatureAsync(state.userLists, node.fileSignature));
        if(found){
          logInsertEvent('duplicate-detected-final', { reason: 'signature-match', signature: node.fileSignature, existingNodeId: found.id, nodeId: node.id });
          const ok = confirm('이미 동일한 문서가 목록에 있습니다. 중복 추가하시겠습니까? (확인=추가, 취소=취소)');
          if(!ok){ logInsertEvent('duplicate-aborted-final', { nodeId: node.id, existingNodeId: found.id }); return false; }
          logInsertEvent('duplicate-allowed-by-user-final', { nodeId: node.id, existingNodeId: found.id });
        }
      }
      // Extra quick checks for fileId / remoteUrl as a last resort before insertion
      if(node.fileId && findNodeByFileId(state.userLists, node.fileId)){
        logInsertEvent('duplicate-detected-final', { reason: 'fileId-match', fileId: node.fileId, nodeId: node.id });
        const ok = confirm('이미 동일한 문서가 목록에 있습니다. 중복 추가하시겠습니까? (확인=추가, 취소=취소)');
        if(!ok){ logInsertEvent('duplicate-aborted-final', { reason: 'fileId-match', nodeId: node.id }); return false; }
        logInsertEvent('duplicate-allowed-by-user-final', { reason: 'fileId-match', nodeId: node.id });
      }
      if(node.remoteUrl && findNodeByRemoteUrl(state.userLists, node.remoteUrl)){
        logInsertEvent('duplicate-detected-final', { reason: 'remoteUrl-match', remoteUrl: node.remoteUrl, nodeId: node.id });
        const ok = confirm('이미 동일한 문서가 목록에 있습니다. 중복 추가하시겠습니까? (확인=추가, 취소=취소)');
        if(!ok){ logInsertEvent('duplicate-aborted-final', { reason: 'remoteUrl-match', nodeId: node.id }); return false; }
        logInsertEvent('duplicate-allowed-by-user-final', { reason: 'remoteUrl-match', nodeId: node.id });
      }
    }catch(e){ console.warn('final dup-check failed', e); }

    return addNodeToParent(parentId, node);
  }catch(e){ console.warn('addNodeToParentWithDupCheck failed', e); return false; }
}

// Traverse lists and try to find a node whose content signature matches `signature`.
// For nodes that lack a fileSignature but do have a fileId, read the blob and compute the signature on-the-fly.
// Returns the matching node or null.
async function findNodeByFileSignatureAsync(lists, signature){
  if(window.ListCore && typeof window.ListCore.findNodeByFileSignatureAsync === 'function') return await window.ListCore.findNodeByFileSignatureAsync(lists, signature);
  console.error('ListCore.findNodeByFileSignatureAsync is required but missing');
  return null;
}

function findAndRemoveNode(lists, id){
  if(window.ListCore && typeof window.ListCore.findAndRemoveNode === 'function') return window.ListCore.findAndRemoveNode(lists, id);
  console.error('ListCore.findAndRemoveNode is required but missing');
  return null;
}

function isDescendant(nodeId, candidateParentId){
  if(window.ListCore && typeof window.ListCore.isDescendant === 'function') {
    // ListCore.isDescendant(node, ancestorId, lists) 형식으로 호출
    const node = window.ListCore.findNodeById(state.userLists, nodeId);
    if(!node) return false;
    return window.ListCore.isDescendant(node, candidateParentId, state.userLists);
  }
  console.error('ListCore.isDescendant is required but missing');
  return false;
}

// Compute the height (max depth) of a subtree rooted at `node`.
// Returns 1 for a node with no children, 1 + max(child heights) otherwise.
function subtreeHeight(node){
  if(window.ListCore && typeof window.ListCore.subtreeHeight === 'function') return window.ListCore.subtreeHeight(node);
  console.error('ListCore.subtreeHeight is required but missing');
  return 1;
}

// Snapshot helper: return compact context for a node (parent id and parent's children ids)
function snapshotForNode(nodeId){
  if(window.ListCore && typeof window.ListCore.snapshotForNode === 'function') return window.ListCore.snapshotForNode(state.userLists, nodeId);
  console.error('ListCore.snapshotForNode is required but missing');
  return { nodeId, parentId: null, parentChildrenIds: [] };
}

// Local move implementation (used as fallback when ListCore isn't available)
function _localMoveNode(nodeId, targetParentId){
  // Minimal wrapper that delegates to ListCore.moveNode. Caller must ensure ListCore exists.
  return enqueueOperation(()=> window.ListCore.moveNode(state.userLists, nodeId, targetParentId, null, { clone:false, regenerateIds:false, save:true })
    .then(()=>{ try{ renderSidebar(); renderListContents(); }catch(_){ } })
    .catch(e=>{ console.error('ListCore.moveNode failed in _localMoveNode', e); })
  );
}

// Public wrapper that prefers ListCore.moveNode when available, otherwise falls back
function moveNode(nodeId, targetParentId){
  console.log('🔥 MOVE NODE called:', { nodeId, targetParentId });
  // enqueueOperation 제거 - 호출하는 곳에서 이미 큐잉함
  return (async ()=> {
    console.log('🔥 MOVE NODE: executing directly...');
    try {
      console.log('🔥 MOVE NODE executing...');
      // ListCore 상태를 app.js 상태와 동기화
      if(window.ListCore) {
        window.ListCore.state.lists = JSON.parse(JSON.stringify(state.userLists));
        console.log('✅ ListCore state synced');
      } else {
        console.error('❌ ListCore not available!');
        return;
      }
      
      await window.ListCore.moveNode(state.userLists, nodeId, targetParentId, null, { clone:false, regenerateIds:false, save:true });
      console.log('✅ ListCore.moveNode completed');
      
      // 🔍 상태 검증 및 동기화
      console.log('🔍 POST-MOVE STATE CHECK:');
      console.log('state.userLists:', JSON.stringify(state.userLists, null, 2));
      console.log('ListCore.state.lists:', JSON.stringify(window.ListCore.state.lists, null, 2));
      
      // ListCore에서 app.js로 상태 동기화 - 중첩된 자식목록까지 보존
      state.userLists = JSON.parse(JSON.stringify(window.ListCore.state.lists));
      console.log('🔄 State synced from ListCore to app.js after moveNode');
      
      // 🔄 CRITICAL: 동기화 후 다시 ListCore에 반영하여 일관성 보장
      window.ListCore.state.lists = JSON.parse(JSON.stringify(state.userLists));
      console.log('🔄 Final sync: app.js → ListCore completed');
      
      renderSidebar(); 
      renderListContents(); 
      // 추가 저장 보장 (fallback for ListCore save failures)
      await saveLists();
      console.log('✅ Move operation completed successfully');
    } catch(e) { 
      console.error('❌ Move operation failed:', e);
      // 깊이 제한 에러인 경우 사용자 친화적 메시지 표시
      if(e && e.message && (e.message.includes('Maximum depth limit exceeded') || e.message.toLowerCase().includes('max depth'))){
        console.warn('moveNode prevented due to depth limit', e);
        try{ showToast('이동 실패: 최대 깊이(5)를 초과하여 이동할 수 없습니다.', { variant:'warn' }); }catch(err){}
        return;
      }
      console.error('ListCore.moveNode failed in moveNode', e); 
      throw e;
    }
  })();
}

function moveNodeToIndex(nodeId, targetParentId, index){
  console.log('🔥 MOVE NODE TO INDEX called:', { nodeId, targetParentId, index });
  // enqueueOperation 제거 - 호출하는 곳에서 이미 큐잉함
  return (async ()=> {
    console.log('🔥 MOVE NODE TO INDEX: executing directly...');
    try {
      console.log('🔥 MOVE NODE TO INDEX executing...');
      // ListCore 상태를 app.js 상태와 동기화
      if(window.ListCore) {
        console.log('🔥 MOVE NODE TO INDEX: syncing ListCore state...');
        window.ListCore.state.lists = JSON.parse(JSON.stringify(state.userLists));
        console.log('✅ ListCore state synced for moveNodeToIndex');
      } else {
        console.error('❌ ListCore not available in moveNodeToIndex!');
        return;
      }
      
      console.log('🔥 MOVE NODE TO INDEX: calling ListCore.moveNode...');
      await window.ListCore.moveNode(state.userLists, nodeId, targetParentId, index, { clone:false, regenerateIds:false, save:true });
      console.log('✅ ListCore.moveNode (with index) completed');
      
      // 🔍 상태 검증
      console.log('🔍 POST-MOVE STATE CHECK:');
      console.log('state.userLists:', JSON.stringify(state.userLists, null, 2));
      console.log('ListCore.state.lists:', JSON.stringify(window.ListCore.state.lists, null, 2));
      
      // ListCore에서 app.js로 상태 동기화
      state.userLists = JSON.parse(JSON.stringify(window.ListCore.state.lists));
      console.log('🔄 State synced from ListCore to app.js');
      
      // 🔄 CRITICAL: 동기화 후 다시 ListCore에 반영하여 일관성 보장  
      window.ListCore.state.lists = JSON.parse(JSON.stringify(state.userLists));
      console.log('🔄 Final sync: app.js → ListCore completed for moveNodeToIndex');
      
      console.log('🔥 MOVE NODE TO INDEX: rendering...');
      renderSidebar(); 
      renderListContents(); 
      // 추가 저장 보장 (fallback for ListCore save failures)
      await saveLists();
      console.log('✅ MoveToIndex operation completed successfully');
    } catch(e) { 
      console.error('❌ MoveToIndex operation failed:', e);
      // 깊이 제한 에러인 경우 사용자 친화적 메시지 표시
      if(e && e.message && (e.message.includes('Maximum depth limit exceeded') || e.message.toLowerCase().includes('max depth'))){
        console.warn('moveNodeToIndex prevented due to depth limit', e);
        try{ showToast('이동 실패: 최대 깊이(5)를 초과하여 이동할 수 없습니다.', { variant:'warn' }); }catch(err){}
        return;
      }
      console.error('ListCore.moveNode failed in moveNodeToIndex', e); 
      throw e;
    }
  })();
}

function addNodeToParent(parentId, node){
  console.log('🔥 ADD NODE TO PARENT called:', { parentId, nodeId: node?.id, nodeName: node?.name });
  console.log('🔍 Current state.userLists before add:', state.userLists?.length || 'null');
  
  if(!parentId){
        // append via centralized helper (will fallback if ListCore missing)
        tryInsertAtIndex(null, state.userLists.length, node, ()=>{});
        
        // 🔄 CRITICAL: ListCore 상태 동기화
        if(window.ListCore) {
          window.ListCore.state.lists = JSON.parse(JSON.stringify(state.userLists));
          console.log('✅ ListCore state synced after root append');
        }
        
        console.log('🔍 Current state.userLists after root add:', state.userLists?.length || 'null');
        return true;
  }
  const ok = appendChildToParent(state.userLists, parentId, node);
  console.log('🔍 appendChildToParent result:', ok);
  
  // 🔄 CRITICAL: ListCore 상태 동기화 - 자식 추가 후 즉시 반영
  if(window.ListCore) {
    window.ListCore.state.lists = JSON.parse(JSON.stringify(state.userLists));
    console.log('✅ ListCore state synced after appendChildToParent');
  }
  
  console.log('🔍 Current state.userLists after child add:', state.userLists?.length || 'null');
  
  saveLists();
  renderSidebar();
  renderListContents();
  // If an editable prototype UI exists in the DOM, mount it and wire change events
  try{
    if(window.ListCore && typeof window.ListCore.mountEditableTree === 'function'){
      const root = document.getElementById('rootList');
      const input = document.getElementById('newItemInput');
      const addBtn = document.getElementById('addItemBtn');
      if(root && (input || addBtn)){
        // mount editor seeded from current state (preserve metadata)
        const seed = Array.isArray(state.userLists) ? state.userLists : [];
        try{
          window._listcore_editor = window.ListCore.mountEditableTree({ rootList: root, input: input, addBtn: addBtn, initialItems: seed });
        }catch(e){ console.warn('mountEditableTree failed', e); }

        // listen for serialized DOM->tree changes (free-form edits)
        root.addEventListener('listcore:change', async (ev)=>{
          try{
            const tree = ev.detail && ev.detail.tree ? ev.detail.tree : null;
            if(!Array.isArray(tree)) return;
            function toNode(t){
              return {
                id: t.id || crypto.randomUUID(), name: t.name || '', type: t.type || undefined,
                fileId: t.fileId || undefined, remoteUrl: t.remoteUrl || undefined, fileSignature: t.fileSignature || undefined,
                children: Array.isArray(t.children) ? t.children.map(c=>toNode(c)) : []
              };
            }
            const newLists = tree.map(t=> toNode(t));
            await enqueueOperation(async ()=>{
              state.userLists = newLists;
              try{ if(window.ListCore && typeof window.ListCore.saveLists === 'function') await window.ListCore.saveLists(state.userLists); else await saveLists(); }catch(e){ console.warn('saveLists during mount sync failed', e); }
              try{ renderSidebar(); renderListContents(); }catch(e){}
            });
          }catch(e){ console.warn('listcore:change handler failed', e); }
        });

        // listen for move intents from editor and apply via ListCore to avoid DOM-cycle bugs
        root.addEventListener('listcore:intent-move', async (ev)=>{
          try{
            const d = ev.detail || {};
            const draggedId = d.draggedId || null;
            const targetParentId = typeof d.targetParentId !== 'undefined' ? d.targetParentId : null;
            const index = typeof d.index === 'number' ? d.index : null;
            if(!draggedId) return;
            await enqueueOperation(async ()=>{
              if(window.ListCore && typeof window.ListCore.moveNode === 'function'){
                try{
                  await window.ListCore.moveNode(state.userLists, draggedId, targetParentId, index, { clone:false, regenerateIds:false, save:true });
                }catch(err){ console.warn('ListCore.moveNode failed', err); }
              } else {
                try{ moveNodeToIndex(draggedId, targetParentId, index); }catch(e){ console.warn('fallback moveNodeToIndex failed', e); }
              }
              // remount editor UI to reflect updated state
              try{ root.innerHTML = ''; window._listcore_editor = window.ListCore.mountEditableTree({ rootList: root, input: input, addBtn: addBtn, initialItems: state.userLists }); }catch(e){ console.warn('remount editor failed', e); }
              try{ renderSidebar(); renderListContents(); }catch(e){}
            });
          }catch(e){ console.warn('intent-move handler failed', e); }
        });
      }
    }
  }catch(e){ console.warn('editable tree mount check failed', e); }
  // Wire the verbose log toggle button (added to index.html). This toggles
  // window.__PAPERSCOUT_DEBUG__ and ensures window.psDebug is set so psDebug
  // wrapper above will forward to console when enabled.
  try{
    const toggleBtn = document.getElementById('toggleVerboseLogs');
    if(toggleBtn){
      const updateLabel = ()=>{ try{ toggleBtn.textContent = window.__PAPERSCOUT_DEBUG__ ? '로그:ON' : '로그:OFF'; }catch(e){} };
      // initialize based on current flag
      if(typeof window.__PAPERSCOUT_DEBUG__ === 'undefined') window.__PAPERSCOUT_DEBUG__ = false;
      // ensure a sensible psDebug target exists when toggled on/off
      window.psDebug = window.psDebug || function(){};
      updateLabel();
      toggleBtn.addEventListener('click', ()=>{
        try{
          window.__PAPERSCOUT_DEBUG__ = !window.__PAPERSCOUT_DEBUG__;
          if(window.__PAPERSCOUT_DEBUG__){ window.psDebug = console.debug.bind(console); }
          else { window.psDebug = function(){}; }
          updateLabel();
          showToast(`Verbose 로그 ${window.__PAPERSCOUT_DEBUG__ ? '활성화' : '비활성화'}`, { variant:'info' });
        }catch(e){ console.warn('toggleVerboseLogs handler failed', e); }
      });
    }
  }catch(e){ console.warn('toggleVerboseLogs wiring failed', e); }

  // Wire the clean duplicates button if present
  try{
    const cleanBtn = document.getElementById('cleanDuplicatesBtn');
    if(cleanBtn){
      cleanBtn.addEventListener('click', async ()=>{
        try{
          if(!confirm('중복 레코드를 검사하고 병합/삭제를 수행합니다. 계속하시겠습니까?')) return;
          const rep = await cleanDuplicateRecords();
          showToast(`중복 정리 완료: ${rep.removedIds.length}개 항목 삭제`, { variant:'info' });
          console.info('cleanDuplicateRecords result', rep);
          renderSidebar(); renderListContents();
        }catch(e){ console.warn('cleanDuplicatesBtn handler failed', e); showToast('중복 정리 중 오류가 발생했습니다.', { variant:'error' }); }
      });
    }
  }catch(e){ console.warn('cleanDuplicatesBtn wiring failed', e); }
  // Brand link: navigate back to main page and reset search state without full reload
  try{
    const brand = document.getElementById('brandLink');
    if(brand){
      brand.addEventListener('click', (ev)=>{
        ev.preventDefault();
        console.log('🏠 로고 클릭됨 - 홈페이지 초기화 시작');
        
        // 복원 방지 플래그 설정
        window._preventRestore = true;
        
        // reset form and search-related state
        try{ els.form.reset(); }catch(e){}
        state.q = state.yFrom = state.yTo = state.journal = "";
        state.sort = "relevance";
        state.page = 1;
        state.items = [];
        state.total = 0;
        state.hasSearched = false;
        
        // 선택된 목록 초기화
        state.selectedListId = null;
        
        // 검색 결과 localStorage 강력 클리어
        try {
          localStorage.removeItem('paperscout_search_state');
          localStorage.removeItem('paperscout_search_results');
          // 모든 관련 키 삭제
          const keysToRemove = [];
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.includes('paperscout_search')) {
              keysToRemove.push(key);
            }
          }
          keysToRemove.forEach(key => localStorage.removeItem(key));
          console.log('🗑️ 모든 검색 관련 localStorage 클리어됨:', keysToRemove);
        } catch(e) {
          console.warn('localStorage 클리어 실패:', e);
        }
        
        // 폼 필드도 확실히 초기화
        if (els.q) els.q.value = "";
        if (els.sort) els.sort.value = "relevance";
        if (els.yFrom) els.yFrom.value = "";
        if (els.yTo) els.yTo.value = "";
        if (els.journal) els.journal.value = "";
        
        // 상태 강제 초기화
        state.items = [];
        state.total = 0;
        state.hasSearched = false;
        
        // 결과 영역 강제 클리어 및 숨기기 (렌더링 전에)
        try {
          if (els.resultsList) {
            els.resultsList.innerHTML = '';
            els.resultsList.style.display = 'none';
          }
          if (els.resultsMeta) {
            els.resultsMeta.textContent = '';
            els.resultsMeta.innerHTML = '';
          }
          if (els.empty) els.empty.hidden = false;
          if (els.resultsSection) {
            els.resultsSection.hidden = true;
            els.resultsSection.style.display = 'none';
            els.resultsSection.style.visibility = 'hidden';
            els.resultsSection.setAttribute('hidden', 'true');
            console.log('🎯 결과 섹션 강제 숨김');
          }
          // 페이지네이션도 숨기기
          if (els.pagination) {
            els.pagination.innerHTML = '';
            els.pagination.style.display = 'none';
          }
          
          // 모든 .result-item, .results 관련 요소 강제 제거
          document.querySelectorAll('.result-item, .results__list li').forEach(el => {
            try { el.remove(); } catch(e) {}
          });
          
          console.log('🧹 모든 결과 요소 강제 제거 완료');
        } catch(e) {
          console.warn('결과 영역 강제 클리어 실패:', e);
        }
        
        // UI 렌더링 (검색 결과 클리어) - 상태가 이미 초기화된 후
        renderChips(); 
        renderResults();
        renderSidebar();
        
        // 사이드바가 열려있다면 닫기
        try {
          const sidebar = document.querySelector('.sidebar');
          if (sidebar && sidebar.classList.contains('sidebar--open')) {
            sidebar.classList.remove('sidebar--open');
          }
        } catch(e) {
          console.warn('사이드바 닫기 실패:', e);
        }
        
        // update URL to root (no reload) so bookmarking behaves like main page
        try{ history.pushState({}, '', '/'); }catch(e){}
        // close any open dialogs
        try{ document.querySelectorAll('dialog[open]').forEach(d=>d.close()); }catch(e){}
        
        console.log('✅ 홈페이지 초기화 완료');
        console.log('🔍 초기화 후 상태 확인:', {
          hasSearched: state.hasSearched,
          itemsLength: state.items?.length || 0,
          total: state.total
        });
        
        // 즉시 한 번 더 강제 클리어 (비동기 작업 대비)
        setTimeout(() => {
          console.log('🔄 1차 추가 클리어 실행');
          state.hasSearched = false;
          state.items = [];
          state.total = 0;
          
          try {
            if (els.resultsList) els.resultsList.innerHTML = '';
            if (els.resultsSection) {
              els.resultsSection.hidden = true;
              els.resultsSection.style.display = 'none';
            }
            document.querySelectorAll('.result-item').forEach(el => el.remove());
          } catch(e) {}
        }, 100);
        
        // 복원 방지 플래그 해제 (잠깐 후)
        setTimeout(() => {
          window._preventRestore = false;
          console.log('🔓 복원 방지 플래그 해제됨');
          
          // 한 번 더 확인하여 혹시 복원되었다면 다시 클리어
          if (state.hasSearched || (state.items && state.items.length > 0)) {
            console.log('⚠️ 복원이 감지됨 - 다시 클리어');
            state.hasSearched = false;
            state.items = [];
            state.total = 0;
            
            try {
              if (els.resultsList) els.resultsList.innerHTML = '';
              if (els.resultsSection) {
                els.resultsSection.hidden = true;
                els.resultsSection.style.display = 'none';
              }
              document.querySelectorAll('.result-item').forEach(el => el.remove());
            } catch(e) {}
          }
        }, 3000); // 3초로 더 늘림
      });
    }
  }catch(e){ console.warn('brand link handler setup failed', e); }
  // PDF 뷰어 링크: 사이드바를 유지한 채로 파일 선택기 또는 원격 URL 입력을 열도록 처리
  try{
    const openViewer = document.getElementById('openViewerLink');
    if(openViewer){
      openViewer.addEventListener('click', (ev)=>{
        ev.preventDefault();
        // ensure sidebar visible (if app supports collapsing)
        try{ const s = document.getElementById('sidebar'); if(s && s.classList.contains('collapsed')){ s.classList.remove('collapsed'); } }catch(e){}
        // focus the pdf section and offer choice: 파일 or URL
        try{
          const choice = confirm('로컬 파일을 열려면 확인(예)을 누르고, 원격 URL을 입력하려면 취소(아니오)를 누르세요.');
          if(choice){ // open file picker
            els.uploadPdf?.click();
          } else {
            const url = prompt('원격 PDF URL을 입력하세요 (https://...)');
            if(url){
              // if uploadEndpoint set, offer to open via proxy
              const ep = localStorage.getItem('uploadEndpoint');
              if(ep && confirm('프록시를 통해 열려면 확인, 직접 열려면 취소')){
                let proxyBase = ep; try{ proxyBase = (new URL(ep)).origin; }catch(e){}
                proxyBase = proxyBase.replace(/\/$/, '');
                const proxyUrl = `${proxyBase}/proxy?url=${encodeURIComponent(url)}`;
                try{ if(els.pdfSection) els.pdfSection.hidden = false; if(els.pdfName) els.pdfName.textContent = url; els.pdfFrame.src = proxyUrl; }catch(e){ console.warn(e); }
              } else {
                try{ if(els.pdfSection) els.pdfSection.hidden = false; if(els.pdfName) els.pdfName.textContent = url; els.pdfFrame.src = url; }catch(e){ console.warn(e); }
              }
            }
          }
        }catch(e){ console.warn('openViewerLink handler failed', e); }
      });
    }
  }catch(e){ console.warn('openViewerLink setup failed', e); }
  return ok;
}

async function handlePdfFile(file, forcedParentId){
  if(!file) return;
  // persist file blob into IndexedDB 'files' store so it survives reloads
  const fileId = crypto.randomUUID();
  // compute signature for dedupe and debugging purposes
  let fileSignature = null;
  try{ fileSignature = await hashBlob(file); }catch(e){ console.warn('hashBlob failed in handlePdfFile', e); }
  // wait for the blob to be written before attempting to open the viewer — avoids a race
  try{ await dbPutFile(fileId, file); }catch(e){ console.warn('dbPutFile failed', e); }
  psDebug('[handlePdfFile] fileId=', fileId, 'fileName=', file.name, 'selectedList=', state.selectedListId);
  // Determine parent: prefer the currently selected list (if it's not a PDF node), otherwise fall back to '라이브러리'
  let parentId = typeof forcedParentId !== 'undefined' && forcedParentId !== null ? forcedParentId : state.selectedListId;
  const parentNode = parentId ? findNodeById(state.userLists, parentId) : null;
  if(!parentNode || parentNode.type === 'pdf'){
    let lib = findListByName(state.userLists, '라이브러리');
    if(!lib){
      const id = crypto.randomUUID();
      lib = { id, name: '라이브러리', children: [] };
      // prefer ListCore insertion to persist centrally
      try{
        if(window.ListCore && typeof window.ListCore.insertAtIndex === 'function'){
          try{
            await window.ListCore.insertAtIndex(state.userLists, null, state.userLists.length, lib, { clone:false, regenerateIds:false, save:true });
          }catch(err){
            if(err && err.message && err.message.toLowerCase().includes('max depth')){
              try{ showToast('목록을 추가할 수 없습니다: 최대 깊이(5)를 초과합니다.', { variant:'warn' }); }catch(e){}
            } else {
              console.warn('creating library failed, falling back', err);
              tryInsertAtIndex(null, state.userLists.length, lib);
              await saveLists();
            }
          }
        } else {
          tryInsertAtIndex(null, state.userLists.length, lib);
          await saveLists();
        }
      }catch(e){ console.warn('creating library failed, falling back', e); tryInsertAtIndex(null, state.userLists.length, lib); await saveLists(); }
    }
    parentId = lib.id;
  }

  // create pdf node under chosen parent and reference saved fileId
  const pdfNode = { id: crypto.randomUUID(), name: file.name, fileId, fileSignature: fileSignature || null, type: 'pdf', children: [] };
  logInsertEvent('handlePdfFile-insert', { parentId, nodeId: pdfNode.id, fileId: pdfNode.fileId, signature: pdfNode.fileSignature });
  await addNodeToParentWithDupCheck(parentId, pdfNode);
  state.selectedListId = parentId;
  renderSidebar();
  // If an upload endpoint is configured, upload the blob first and open the server URL
  // — this yields a stable URL that avoids blob/data URL quirks in some browsers.
  try{
    const ep = localStorage.getItem('uploadEndpoint');
    if(ep){
      try{
        const result = await uploadBlobToServer(fileId, pdfNode, ep);
        if(result && result.url){
          // use server URL for viewing (more reliable than blob in many environments)
          pdfNode.remoteUrl = result.url;
          try{ await saveLists(); }catch(_){}
          if(els.pdfName) els.pdfName.textContent = pdfNode.name || pdfNode.title || '문서';
          if(els.pdfSection) els.pdfSection.hidden = false;
          if(els.pdfFrame){ try{ els.pdfFrame.src = result.url; els.pdfFrame.focus(); }catch(e){ console.warn('failed to set iframe src to remote url', e); } }
          try{ pushRecent(pdfNode); }catch(_){ }
          return;
        }
      }catch(e){ console.warn('auto upload failed', e); }
    }
  }catch(e){ console.warn('upload-check failed', e); }
  // fallback: open from local blob
  openPdfNode(pdfNode).catch(e=>{
    console.error('openPdfNode failed after upload', e);
  });
  try{ pushRecent(pdfNode); }catch(_){ }
  // optionally upload to server if configured
  try{
    const ep = localStorage.getItem('uploadEndpoint');
    const auto = localStorage.getItem('autoUpload') === 'true';
    if(ep && auto){
      uploadBlobToServer(fileId, pdfNode, ep).catch(e=> console.warn('uploadBlobToServer failed', e));
    }
  }catch(e){ console.warn('upload-settings-read-failed', e); }
}

function renderListContents(){
  const container = els.listContents;
  if(!container) return;
  container.innerHTML = '';
  if(!state.selectedListId) return;
  const node = findNodeById(state.userLists, state.selectedListId);
  if(!node) return;

  // Collect all descendant PDF nodes (flat list)
  const pdfs = [];
  function collectPdfLeaves(n){
    if(!n) return;
    if(n.type === 'pdf') { pdfs.push(n); return; }
    if(Array.isArray(n.children)){
      for(const c of n.children) collectPdfLeaves(c);
    }
  }
  // If selected node itself is a PDF, show it; otherwise walk its children
  if(node.type === 'pdf') pdfs.push(node);
  else if(Array.isArray(node.children)) for(const c of node.children) collectPdfLeaves(c);

  // render as a semantic flat list (UL > LI)
  // Deduplicate the collected PDF nodes by signature/fileId/remoteUrl to avoid
  // rendering duplicate DOM entries when the underlying lists mistakenly
  // contain multiple references to the same file.
  const deduped = [];
  try{
    const seen = new Set();
    for(const p of pdfs){
      const key = p.fileSignature || p.fileId || p.remoteUrl || p.id;
      const k = String(key || p.id);
      if(seen.has(k)){
        logInsertEvent('render-dedupe-skip', { nodeId: p.id, key: k });
        continue;
      }
      seen.add(k);
      deduped.push(p);
    }
  }catch(e){ console.warn('renderListContents: dedupe failed', e); }

  container.innerHTML = '<ul class="list-rows" role="list" aria-label="목록 항목"></ul>';
  const ul = container.querySelector('.list-rows');
  for(const child of pdfs){
    // iterate over deduped list
    continue;
  }
  for(const child of deduped){
    const li = document.createElement('li'); li.className = 'list-row list-card';
    if(child.type === 'pdf') li.classList.add('list-card--pdf','list-row--pdf');
    li.dataset.id = child.id;
    li.tabIndex = 0;
    li.setAttribute('role','button');
    const title = document.createElement('div'); title.className='title'; title.textContent = child.name || '(이름 없음)';
  // meta removed per UX: avoid redundant "PDF 파일" label in list rows
    // allow dragging from the list for PDF items
    if(child.type === 'pdf'){
      li.draggable = true;
      li.addEventListener('dragstart', (ev)=>{
        try{
          ev.dataTransfer.setData('text/x-list-id', child.id);
          ev.dataTransfer.setData('text/plain', child.id);
          ev.dataTransfer.effectAllowed = 'move';
          li.classList.add('dragging');
          psDebug('[dragstart][row]', child.id);
        }catch(e){ console.warn('row dragstart failed', e); }
      });
      li.addEventListener('dragend', ()=>{ li.classList.remove('dragging'); });
    }
    // build actions container (reuse existing small actions pattern)
    const actions = document.createElement('div'); actions.className = 'actions';
    const btnDelete = document.createElement('button'); btnDelete.className='btn btn--sm btn--ghost js-delete'; btnDelete.type='button'; btnDelete.textContent='✕';
    actions.appendChild(btnDelete);
    // upload controls for PDF items
    if(child.type === 'pdf'){
      const uploadBtn = document.createElement('button'); uploadBtn.className='btn btn--sm btn--primary js-upload'; uploadBtn.type='button';
      const statusSpan = document.createElement('span'); statusSpan.className='upload-badge';
      if(child.remoteUrl){ statusSpan.textContent = '업로드됨'; uploadBtn.textContent = '열기'; uploadBtn.disabled = false; }
      else if(child.uploadStatus === 'uploading'){ statusSpan.textContent = `업로드중 ${child.uploadProgress?child.uploadProgress+'%':''}`; uploadBtn.textContent = '업로드중...'; uploadBtn.disabled = true; }
      else if(child.uploadStatus === 'failed'){ statusSpan.textContent = '실패'; uploadBtn.textContent = '재시도'; uploadBtn.disabled = false; }
      else { statusSpan.textContent = ''; uploadBtn.textContent = '업로드'; uploadBtn.disabled = false; }
      actions.appendChild(statusSpan);
      actions.appendChild(uploadBtn);
    }
  li.append(title, actions);
    ul.appendChild(li);
  }

  // delegated handlers for click/keyboard inside the flat list
  els.listContents?.addEventListener('click', async (e)=>{
    const row = e.target.closest('.list-row'); if(!row) return;
    const id = row.dataset.id; if(!id) return;
    const node = findNodeById(state.userLists, id);
    if(!node) return;
    // delete
    if(e.target.closest('.js-delete')){ await deleteList(id); return; }
    // upload/open
    if(e.target.closest('.js-upload')){
      const ep = localStorage.getItem('uploadEndpoint');
      if(!ep){ showToast('업로드 엔드포인트가 설정되어 있지 않습니다. 설정 페이지를 엽니다.', { variant:'warn' }); els.setUploadEndpoint?.click(); return; }
      if(node.remoteUrl){ window.open(node.remoteUrl, '_blank'); return; }
      (async ()=>{ try{ await uploadBlobToServer(node.fileId, node, ep); }catch(err){ console.warn('upload triggered failed', err); }})();
      return;
    }
    // open viewer
    if(node.type === 'pdf'){
      try{
        if(node.fileId){ window.location.href = createPdfViewerUrl(`fileId=${encodeURIComponent(node.fileId)}`); return; }
        else if(node.remoteUrl){ window.location.href = createPdfViewerUrl(`url=${encodeURIComponent(node.remoteUrl)}`); return; }
      }catch(e){ console.warn('navigate to viewer failed', e); }
      openPdfNode(node).catch(err=>console.error('openPdfNode failed', err));
    }
  });

  els.listContents?.addEventListener('keydown', (e)=>{
    if(e.key === 'Enter' || e.key === ' '){ const row = e.target.closest('.list-row'); if(!row) return; row.click(); }
  });
}
async function renderPdfPage(pageNum){
  const pdf = window._currentPdfDoc; if(!pdf) return;
  pageNum = Math.max(1, Math.min(pageNum, pdf.numPages));
  const page = await pdf.getPage(pageNum);
  const scale = window._currentPdfScale || 1.0;
  const viewport = page.getViewport({ scale });
  const canvas = els.pdfCanvas; if(!canvas) return;
  const ctx = canvas.getContext('2d');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const renderContext = { canvasContext: ctx, viewport };
  const renderTask = page.render(renderContext);
  await renderTask.promise;
  window._currentPdfPage = pageNum;
  if(els.pdfPageInfo) els.pdfPageInfo.textContent = `${window._currentPdfPage} / ${pdf.numPages}`;
}

// controls
els.pdfPrev?.addEventListener('click', ()=>{ if(!window._currentPdfDoc) return; if(window._currentPdfPage>1){ renderPdfPage(window._currentPdfPage-1); } });
els.pdfNext?.addEventListener('click', ()=>{ if(!window._currentPdfDoc) return; if(window._currentPdfPage < window._currentPdfDoc.numPages){ renderPdfPage(window._currentPdfPage+1); } });
els.pdfZoomIn?.addEventListener('click', ()=>{ if(!window._currentPdfDoc) return; window._currentPdfScale = Math.min((window._currentPdfScale||1)*1.2, 5); renderPdfPage(window._currentPdfPage); });
els.pdfZoomOut?.addEventListener('click', ()=>{ if(!window._currentPdfDoc) return; window._currentPdfScale = Math.max((window._currentPdfScale||1)/1.2, 0.2); renderPdfPage(window._currentPdfPage); });

// --- server upload helpers & settings UI ---
function updateUploadButtonUI(){
  const btn = els.setUploadEndpoint;
  if(!btn) return;
  const ep = localStorage.getItem('uploadEndpoint');
  const auto = localStorage.getItem('autoUpload') === 'true';
  btn.textContent = ep ? `서버 업로드: ${auto? 'ON' : 'OFF'}` : '서버 업로드 설정';
  btn.title = ep ? `Endpoint: ${ep}` : 'No endpoint set';
}

els.setUploadEndpoint?.addEventListener('click', ()=>{
  const current = localStorage.getItem('uploadEndpoint') || '';
  const url = prompt('업로드 엔드포인트를 입력하세요 (예: https://example.com/upload)', current);
  if(url === null) return; // cancelled
  const trimmed = (url||'').trim();
  if(!trimmed){ localStorage.removeItem('uploadEndpoint'); localStorage.setItem('autoUpload','false'); updateUploadButtonUI(); showToast('업로드 엔드포인트가 제거되었습니다.', { variant:'info' }); return; }
  localStorage.setItem('uploadEndpoint', trimmed);
  const enable = confirm('파일 업로드를 자동으로 서버에 전송하도록 활성화하시겠습니까? (확인=예)');
  localStorage.setItem('autoUpload', enable ? 'true' : 'false');
  updateUploadButtonUI();
  showToast('업로드 설정이 저장되었습니다.', { variant:'info' });
});

async function uploadBlobToServer(fileId, node, endpoint){
  try{
    // mark uploading
    try{ node.uploadStatus = 'uploading'; node.uploadProgress = 0; saveLists(); renderListContents(); }catch(e){}
    const blob = await dbGetFile(fileId);
    if(!blob) throw new Error('blob-not-found');

    // Use XMLHttpRequest to get upload progress events
    const result = await new Promise((resolve, reject)=>{
      const xhr = new XMLHttpRequest();
      xhr.open('POST', endpoint);
      xhr.responseType = 'json';
      xhr.upload.onprogress = (ev)=>{
        if(ev.lengthComputable){
          const pct = Math.round((ev.loaded / ev.total) * 100);
          node.uploadProgress = pct;
          node.uploadStatus = 'uploading';
          try{ saveLists(); renderListContents(); }catch(_){ }
        }
      };
      xhr.onload = ()=>{
        if(xhr.status >=200 && xhr.status < 300){
          const data = xhr.response || (xhr.responseText ? JSON.parse(xhr.responseText) : null) || {};
          const url = (data && (data.url || data.fileUrl)) || null;
          if(url) node.remoteUrl = url;
          node.uploadedAt = new Date().toISOString();
          node.uploadStatus = 'uploaded';
          node.uploadProgress = 100;
          try{ saveLists(); renderListContents(); }catch(_){ }
          resolve({ ok:true, url });
        } else {
          node.uploadStatus = 'failed';
          try{ saveLists(); renderListContents(); }catch(_){ }
          reject(new Error('upload-failed:'+xhr.status));
        }
      };
      xhr.onerror = ()=>{
        node.uploadStatus = 'failed';
        try{ saveLists(); renderListContents(); }catch(_){ }
        reject(new Error('network-error'));
      };
      const fd = new FormData();
      fd.append('file', blob, node.name || 'upload.pdf');
      fd.append('name', node.name || 'file');
      try{ xhr.send(fd); }catch(err){ node.uploadStatus='failed'; try{ saveLists(); renderListContents(); }catch(_){ } reject(err); }
    });
  psDebug('uploadBlobToServer: uploaded', fileId, '->', result && result.url);
    return result;
  }catch(e){
    console.warn('uploadBlobToServer error', e);
    try{ node.uploadStatus = 'failed'; saveLists(); renderListContents(); }catch(err){}
    return { ok:false, error: String(e) };
  }
}


function normalizeItem(it){
  return {
    id: it.id || it.doi || it.url || crypto.randomUUID(),
    title: it.title || "", authors: it.authors || [],
    journal: it.journal || "", year: it.year || "",
    doi: it.doi || "", url: it.url || "", abstract: it.abstract || "",
    keywords: it.keywords || [],
  };
}

// Sanitize imported lists to enforce max depth and promote PDF leaves when necessary.
const MAX_LIST_DEPTH = 5;
function sanitizeImportedLists(incoming){
  if(!Array.isArray(incoming)) return [];
  const result = [];
  const parentArrays = {};
  parentArrays[1] = result;
  function processNode(node, depth){
    if(!node) return;
    // shallow copy without children
    if(depth <= MAX_LIST_DEPTH){
      const copy = Object.assign({}, node);
      copy.children = [];
      parentArrays[depth].push(copy);
      // prepare child slot
      parentArrays[depth+1] = copy.children;
      if(Array.isArray(node.children)){
        for(const c of node.children) processNode(c, depth+1);
      }
    } else {
      // depth > MAX
      if(node.type === 'pdf'){
        const copy = Object.assign({}, node);
        copy.children = [];
        const target = parentArrays[MAX_LIST_DEPTH] || result;
        target.push(copy);
      } else {
        // non-pdf folder beyond max depth: traverse children and attempt to salvage pdf leaves
        if(Array.isArray(node.children)){
          // ensure there is a target array to collect promoted items
          if(!parentArrays[MAX_LIST_DEPTH]) parentArrays[MAX_LIST_DEPTH] = result;
          for(const c of node.children) processNode(c, depth+1);
        }
      }
    }
  }
  for(const n of incoming) processNode(n, 1);
  return result;
}

function renderResults(){
  console.log('🎨 renderResults 호출됨');
  console.log('🎨 state.hasSearched:', state.hasSearched);
  console.log('🎨 state.items.length:', state.items?.length || 0);
  console.log('🎨 resultsSection element:', els.resultsSection);
  
  // show results section only after a search has been performed
  if(!state.hasSearched){ 
    console.log('🎨 검색 미실행 - 결과 섹션 숨김');
    try{ 
      if(els.resultsSection) {
        els.resultsSection.hidden = true; 
        els.resultsSection.style.display = 'none';
      }
    }catch(e){} 
    return; 
  }
  
  console.log('🎨 결과 섹션 표시');
  try{ 
    if(els.resultsSection) {
      els.resultsSection.hidden = false; 
      els.resultsSection.style.display = 'block';
      console.log('🎨 resultsSection.hidden:', els.resultsSection.hidden);
      console.log('🎨 resultsSection.style.display:', els.resultsSection.style.display);
    }
  }catch(e){
    console.error('🎨 결과 섹션 표시 오류:', e);
  }
  if(els.resultsList) els.resultsList.innerHTML = '';
  
  console.log('🎨 결과 렌더링 시작 - 아이템 수:', state.items?.length || 0);
  
  // 페이지네이션 적용
  const startIndex = (state.page - 1) * state.pageSize;
  const endIndex = startIndex + state.pageSize;
  const pageItems = state.items ? state.items.slice(startIndex, endIndex) : [];
  
  console.log('🎨 페이지네이션:', { 
    page: state.page, 
    pageSize: state.pageSize, 
    startIndex, 
    endIndex, 
    pageItems: pageItems.length 
  });
  
  // render results using the same list-row / list-card structure as the PDF page's list contents
  const ul = document.createElement('ul'); ul.className = 'list-rows results-rows'; ul.setAttribute('role','list');
    for(const it of pageItems){
    const li = document.createElement('li'); li.className = 'list-row list-card result-card';
    li.dataset.id = it.id || '';
    li.tabIndex = 0;
    // allow dragging search results into the sidebar to save them as PDF nodes
    li.draggable = true;
    li.addEventListener('dragstart', (ev)=>{
      try{
        const payload = { id: it.id || null, title: it.title || '', url: it.url || null };
        ev.dataTransfer.setData('application/x-paperscout-result', JSON.stringify(payload));
        // also set a plain text fallback with the url
        if(payload.url) ev.dataTransfer.setData('text/plain', payload.url);
        ev.dataTransfer.effectAllowed = 'copy';
        li.classList.add('dragging');
      }catch(e){ console.warn('result dragstart failed', e); }
    });
    li.addEventListener('dragend', ()=> li.classList.remove('dragging'));
    // title + meta
    const title = document.createElement('div'); title.className = 'title';
    const a = document.createElement('a'); a.className = 'result-card__link'; a.href = it.url || '#'; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.textContent = it.title || '(제목 없음)';
    title.appendChild(a);
    
    const meta = document.createElement('div'); meta.className = 'meta';
    
    // 🔥 기본 메타 정보 (저자, 저널, 연도)
    const basicMeta = document.createElement('div');
    basicMeta.textContent = `${(it.authors||[]).join(', ') || '—'} · ${it.journal||'—'} · ${it.year||'—'}`;
    
    // 🔥 출판사 정보 추가
    if (it.publisher || it.publisherLogo) {
      const publisherBadge = document.createElement('span');
      publisherBadge.className = 'result-card__publisher';
      publisherBadge.style.backgroundColor = it.publisherColor || '#6b7280';
      publisherBadge.textContent = `${it.publisherLogo || '📚'} ${it.publisher || ''}`;
      publisherBadge.title = it.publisher || '';
      basicMeta.appendChild(document.createTextNode(' · '));
      basicMeta.appendChild(publisherBadge);
    }
    
    meta.appendChild(basicMeta);
    
    // 🔥 통계 정보 (Impact Factor, Citation Count, Open Access)
    if (it.impactFactor || it.citationCount || it.openAccess !== undefined) {
      const statsDiv = document.createElement('div');
      statsDiv.className = 'result-card__stats';
      
      if (it.impactFactor) {
        const ifStat = document.createElement('span');
        ifStat.className = 'result-stat result-stat--impact';
        ifStat.innerHTML = `📊 IF: ${it.impactFactor}`;
        statsDiv.appendChild(ifStat);
      }
      
      if (it.citationCount) {
        const citeStat = document.createElement('span');
        citeStat.className = 'result-stat result-stat--citations';
        citeStat.innerHTML = `📝 인용: ${it.citationCount}회`;
        statsDiv.appendChild(citeStat);
      }
      
      if (it.openAccess !== undefined) {
        const accessStat = document.createElement('span');
        accessStat.className = `result-stat result-stat--access ${it.openAccess ? 'open' : ''}`;
        accessStat.innerHTML = it.openAccess ? '🔓 오픈액세스' : '🔒 구독필요';
        statsDiv.appendChild(accessStat);
      }
      
      meta.appendChild(statsDiv);
    }
    
    // 🔥 DOI 및 추가 링크 추가
    if(it.doi || it.url) {
      const linksMeta = document.createElement('div');
      linksMeta.className = 'meta-links';
      linksMeta.style.marginTop = '4px';
      
      if(it.doi) {
        const doiLink = document.createElement('a');
        doiLink.href = '#';
        doiLink.className = 'meta-link doi-link';
        doiLink.textContent = `DOI: ${it.doi}`;
        doiLink.style.cssText = 'color: #0366d6; text-decoration: none; font-size: 0.85rem; margin-right: 12px; cursor: pointer; padding: 2px 6px; border-radius: 4px; background: #f8f9fa; border: 1px solid #e1e8ed; transition: all 0.2s;';
        doiLink.title = 'DOI 주소를 클립보드에 복사';
        
        // 호버 효과 추가
        doiLink.addEventListener('mouseenter', () => {
          doiLink.style.background = '#e3f2fd';
          doiLink.style.borderColor = '#0366d6';
        });
        
        doiLink.addEventListener('mouseleave', () => {
          doiLink.style.background = '#f8f9fa';
          doiLink.style.borderColor = '#e1e8ed';
        });
        
        doiLink.addEventListener('click', async (e) => {
          e.preventDefault();
          const doiUrl = it.url || `https://doi.org/${it.doi}`;
          
          try {
            await navigator.clipboard.writeText(doiUrl);
            showToast(`DOI 주소가 복사되었습니다: ${it.doi}`);
            
            // 시각적 피드백
            const originalText = doiLink.textContent;
            doiLink.textContent = '✓ 복사됨';
            doiLink.style.color = '#059669';
            setTimeout(() => {
              doiLink.textContent = originalText;
              doiLink.style.color = '#0366d6';
            }, 2000);
            
          } catch (err) {
            console.warn('DOI 복사 실패:', err);
            // fallback: 새 탭에서 열기
            window.open(doiUrl, '_blank');
            showToast('클립보드 복사를 지원하지 않아 새 탭에서 열었습니다.');
          }
        });
        
        linksMeta.appendChild(doiLink);
      }
      
      if(it.url && !it.url.includes('doi.org')) {
        const urlLink = document.createElement('a');
        urlLink.href = it.url;
        urlLink.target = '_blank';
        urlLink.rel = 'noopener noreferrer';
        urlLink.className = 'meta-link url-link';
        urlLink.textContent = '원본 보기';
        urlLink.style.cssText = 'color: #0366d6; text-decoration: none; font-size: 0.85rem;';
        linksMeta.appendChild(urlLink);
      }
      
      meta.appendChild(linksMeta);
    }
    
    // 🔥 초록 추가
    if (it.abstract) {
      const abstractDiv = document.createElement('div');
      abstractDiv.className = 'result-card__abstract';
      abstractDiv.style.cssText = 'margin-top: 8px; color: #374151; font-size: 0.9rem; line-height: 1.5;';
      const abstractText = it.abstract.length > 200 ? it.abstract.substring(0, 200) + '...' : it.abstract;
      abstractDiv.textContent = abstractText;
      meta.appendChild(abstractDiv);
    }
    
    // 🔥 키워드 추가
    if (it.keywords && it.keywords.length > 0) {
      const keywordsDiv = document.createElement('div');
      keywordsDiv.className = 'result-card__keywords';
      keywordsDiv.style.cssText = 'margin-top: 8px; display: flex; gap: 6px; flex-wrap: wrap;';
      
      it.keywords.slice(0, 5).forEach(keyword => {
        const keywordTag = document.createElement('span');
        keywordTag.className = 'keyword-tag';
        keywordTag.style.cssText = 'background: #f3f4f6; color: #374151; padding: 2px 8px; border-radius: 12px; font-size: 0.8rem;';
        keywordTag.textContent = keyword;
        keywordsDiv.appendChild(keywordTag);
      });
      
      if (it.keywords.length > 5) {
        const moreTag = document.createElement('span');
        moreTag.className = 'keyword-tag';
        moreTag.style.cssText = 'background: #e5e7eb; color: #6b7280; padding: 2px 8px; border-radius: 12px; font-size: 0.8rem;';
        moreTag.textContent = `+${it.keywords.length - 5}개`;
        keywordsDiv.appendChild(moreTag);
      }
      
      meta.appendChild(keywordsDiv);
    }
    // actions: match list-rows actions (save to list / open in viewer)
    const actions = document.createElement('div'); actions.className = 'actions';
    const btnSave = document.createElement('button'); btnSave.type = 'button'; btnSave.className = 'btn btn--sm btn--ghost js-save'; btnSave.textContent = '저장';
    const btnOpen = document.createElement('button'); btnOpen.type = 'button'; btnOpen.className = 'btn btn--sm btn--primary js-open'; btnOpen.textContent = '열기';
    
    // 다운로드 버튼 추가 (PDF 다운로드 URL이 있는 경우)
    if (it.downloadUrl) {
      const btnDownload = document.createElement('button');
      btnDownload.type = 'button';
      btnDownload.className = 'btn btn--sm btn--success js-download';
      btnDownload.textContent = '📥 다운로드';
      btnDownload.onclick = () => {
        try {
          window.open(it.downloadUrl, '_blank');
          showToast('다운로드를 시작합니다.');
        } catch (error) {
          console.warn('Download failed:', error);
          showToast('다운로드에 실패했습니다.');
        }
      };
      actions.appendChild(btnDownload);
    }
    
    actions.append(btnSave, btnOpen);
    // mark as pdf-like if the url looks like a pdf
    if(it.url && String(it.url).toLowerCase().endsWith('.pdf')) li.classList.add('list-card--pdf','list-row--pdf');
    li.append(title, meta, actions);
    ul.appendChild(li);
  }
  if(els.resultsList) try{ els.resultsList.appendChild(ul); }catch(e){ console.warn('append results ul failed', e); }
  if(els.resultsMeta) els.resultsMeta.textContent = state.total ? `총 ${state.total}건 · 페이지 ${state.page}` : "";
  if(els.empty) els.empty.hidden = state.items.length>0;
  try{ renderPagination(); }catch(e){ console.warn('renderPagination failed', e); }

  // attach a single delegated click handler for results (idempotent)
  if(!_resultsHandlerInstalled){
    els.resultsList?.addEventListener('click', (e)=>{
      const li = e.target.closest('.list-row'); if(!li) return;
      const id = li.dataset.id;
      const item = state.items.find(it => (it.id===id) || (it.id && it.id.toString()===id));
      // save to currently selected list
        if(e.target.closest('.js-save') || e.target.closest('[data-action="add-to-list"]')){
        if(!item) return;
        const node = { id: crypto.randomUUID(), name: item.title || '문서', remoteUrl: item.url || null, type: 'pdf', children: [] };
        (async ()=>{
          try{
            const added = await addNodeToParentWithDupCheck(state.selectedListId || null, node);
            console.log('🔍 addNodeToParentWithDupCheck result:', added);
            if(added){ 
              try{ 
                // addNodeToParent에서 이미 saveLists()와 renderSidebar()를 호출하므로 중복 제거
                // saveLists(); 
                // renderSidebar(); 
                
                // 강제 UI 업데이트를 위해 다음 틱에서 다시 렌더링
                setTimeout(() => {
                  renderSidebar();
                  console.log('🔄 사이드바 강제 재렌더링 완료');
                }, 50);
                showToast('목록에 저장되었습니다.'); 
                console.log('🎯 목록에 추가 완료, 사이드바 렌더링됨');
              }catch(e){ 
                console.error('❌ 목록 저장 후 UI 업데이트 실패:', e); 
              } 
            } else {
              console.log('🚫 목록 추가가 취소되었거나 실패했습니다.');
            }
          }catch(err){ console.warn('save-to-list failed', err); }
        })();
        return;
      }
      // open in viewer via proxy if necessary
      if(e.target.closest('.js-open') || e.target.closest('.result-card__link')){
        if(!item) return;
        const url = item.url;
  if(!url){ showToast('열 수 있는 URL이 없습니다.'); return; }
        // record recent and open pdf-viewer page with url param
        try{ pushRecent({ title: item.title, url: url }); }catch(_){ }
        try{ window.location.href = createPdfViewerUrl(`url=${encodeURIComponent(url)}`); }catch(e){ window.open(url, '_blank'); }
        return;
      }
    });
    _resultsHandlerInstalled = true;
  }
}

function renderPagination(){
  const totalPages = Math.ceil((state.total||0)/state.pageSize)||1;
  const btn = (p, label=p)=>`<button class="page-btn" data-p="${p}" ${p===state.page?'aria-current="page"':''}>${label}</button>`;
  const pages = [];
  
  // 이전 페이지 버튼
  if(state.page > 1) {
    pages.push(btn(state.page-1, "‹"));
  }
  
  // 모든 페이지 번호 표시 (1부터 totalPages까지)
  for(let p=1; p<=totalPages; p++) {
    pages.push(btn(p));
  }
  
  // 다음 페이지 버튼
  if(state.page < totalPages) {
    pages.push(btn(state.page+1, "›"));
  }
  
  if(els.pagination) els.pagination.innerHTML = pages.join("");
}
els.pagination?.addEventListener("click", (e)=>{
  const b = e.target.closest(".page-btn"); if(!b) return;
  const p = Number(b.dataset.p); if(!p || p===state.page) return;
  state.page=p; 
  search();
  
  // 페이지 변경 시 맨 위로 스크롤
  setTimeout(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, 100);
});

// sidebar events (delegation)
// 🔥 DISABLED: Duplicate event listener (using onclick attribute instead)
/*
els.addListBtn?.addEventListener('click', async ()=> {
  console.log('🔥 Add List Button 클릭됨!');
  console.log('ListCore 상태:', !!window.ListCore);
  console.log('newListName 요소:', els.newListName);
  console.log('입력값:', els.newListName?.value);
  
  if (!window.ListCore) {
    console.error('❌ ListCore가 없습니다!');
    return;
  }
  
  try {
    const name = els.newListName.value;
    console.log('📝 목록 추가 시도:', name);
    await window.ListCore.addList(name);
    console.log('✅ 목록 추가 성공!');
    els.newListName.value = '';
    state.selectedListId = window.ListCore.state.selectedId;
    renderListContents();
  } catch (err) {
    console.error('❌ Failed to add list:', err);
    // 사용자에게 에러 표시
    alert('목록 추가에 실패했습니다: ' + err.message);
  }
});
*/

els.newListName?.addEventListener('keydown', async (e)=>{ 
  if(e.key==='Enter'){ 
    e.preventDefault();
    if (!window.ListCore) return;
    try {
      const name = els.newListName.value;
      await window.ListCore.addList(name);
      els.newListName.value = '';
      state.selectedListId = window.ListCore.state.selectedId;
      renderListContents();
    } catch (err) {
      console.error('Failed to add list:', err);
    }
  }
});

els.userLists?.addEventListener('click', async (e)=>{
  const li = e.target.closest('.user-list-item'); if(!li) return;
  const id = li.dataset.id;
  if(e.target.closest('.js-delete')){ await deleteList(id); return; }
  if(e.target.closest('.js-add-child')){
    const childName = prompt('하위 목록 이름을 입력하세요');
    if(childName) addList(childName, id);
    return;
  }
  if(e.target.closest('.js-add-pdf')){
    console.log('🔥 PDF 추가 버튼 클릭됨, parentId:', id);
    console.log('🔥 els.pdfInput 요소:', els.pdfInput);
    // set pending parent and open file picker
    pendingPdfParentId = id;
    if (els.pdfInput) {
      els.pdfInput.click();
      console.log('✅ 파일 선택기 열림');
    } else {
      console.error('❌ pdfInput 요소를 찾을 수 없습니다');
    }
    return;
  }
  // If a specific action button was clicked, handle it first (delete/add-child). Otherwise
  // treat clicking the list item itself as selecting/opening the list — no separate '열기' button needed.
  const node = findNodeById(state.userLists, id);
  if(e.target.closest('.js-select')){
    // backward-compatible: if a select button exists, behave the same
  if(node && node.type === 'pdf'){
  openPdfNode(node).catch(err=>{ console.error('openPdfNode failed', err); });
  state.selectedListId = id; scheduleRender(); return;
  }
    selectList(id); return;
  }
  // default behavior when clicking the list row/title
  if(node && node.type === 'pdf'){
    try{
      if(node.fileId){
        // remember in recent and navigate to viewer page which will read the blob from IndexedDB by fileId
        try{ pushRecent(node); }catch(_){ }
        window.location.href = createPdfViewerUrl(`fileId=${encodeURIComponent(node.fileId)}`);
        return;
      } else if(node.remoteUrl){
        try{ pushRecent(node); }catch(_){ }
        window.location.href = createPdfViewerUrl(`url=${encodeURIComponent(node.remoteUrl)}`);
        return;
      } else {
        // fallback to inline viewer if no fileId/remoteUrl
  openPdfNode(node).catch(err=>{ console.error('openPdfNode failed', err); });
  state.selectedListId = id; scheduleRender(); return;
      }
    }catch(e){ console.warn('navigate to viewer failed', e); openPdfNode(node).catch(()=>{}); }
  }
  selectList(id); return;
});
els.sidebarToggle?.addEventListener('click', ()=>{
  try{
    const s = document.getElementById('sidebar');
    if(!s) return;
    const collapsed = s.classList.toggle('collapsed');
    els.sidebarToggle.setAttribute('aria-expanded', String(!collapsed));
    // persist
    try{ localStorage.setItem('ps_sidebar_collapsed', collapsed ? '1' : '0'); }catch(e){}
    // broadcast to other windows
  try{ if(typeof BroadcastChannel !== 'undefined'){ const bc = new BroadcastChannel('paperscout-sync'); bc.postMessage({ type:'sidebar-collapsed', collapsed: !!collapsed, sender: APP_WINDOW_ID }); bc.close(); } }catch(e){}
  }catch(e){ console.warn('sidebarToggle handler failed', e); }
});

// static sidebar/tab mode removed

// Reset all lists: clear state and persistence, bump version, re-render
els.resetListsBtn?.addEventListener('click', async ()=>{
  try{
    if(!confirm('모든 목록을 초기화하고 처음 상태로 되돌리시겠습니까? (취소하면 취소됩니다)')) return;
    // create a JSON backup and trigger download so user can restore if needed
    try{
      const backup = { lists: state.userLists || [], createdAt: new Date().toISOString() };
      try{ const ver = await dbGet('userListsVersion'); if(typeof ver !== 'undefined') backup.version = ver; }catch(_){ /* ignore */ }
      const data = JSON.stringify(backup, null, 2);
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `paperscout-lists-backup-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(()=>{ try{ URL.revokeObjectURL(url); }catch(e){} }, 1000);
      try{ localStorage.setItem('lastUserListsBackup', JSON.stringify({ ts: Date.now(), size: data.length })); }catch(_){ }
    }catch(e){ console.warn('backup creation failed', e); }
    // clear in-memory
    state.userLists = [];
    // persist via centralized helper if available
    try{ await saveLists(); }catch(e){ console.warn('saveLists during reset failed', e); }
    // bump version so other windows notice
    try{ const cur = (await dbGet('userListsVersion')) || 0; await dbPut('userListsVersion', Number(cur) + 1); }catch(e){ console.warn('bump userListsVersion failed', e); }
    // re-render
    renderSidebar(); renderListContents();
    // notify other windows
    try{ if(typeof window.broadcastUserListsUpdated === 'function'){ window.broadcastUserListsUpdated(); } }catch(e){ console.warn('broadcast failed', e); }
    showToast('목록이 초기화되었습니다.', { variant:'info' });
    // Ask whether the user wants to switch to immutable/static sidebar tab mode
    try{
      const gotoStatic = confirm('목록을 초기화했습니다. 사이드바를 고정 탭 모드로 전환하여 목록이 더 이상 변경되지 않게 하시겠습니까? (확인=전환, 취소=그대로 유지)');
      if(gotoStatic){
        enterStaticSidebarMode();
      } else {
        try{ if(els.sidebarTabs) els.sidebarTabs.hidden = true; }catch(e){}
      }
    }catch(e){ console.warn('post-reset static-mode prompt failed', e); }
  }catch(e){ console.warn('resetLists failed', e); showToast('목록 초기화 중 오류가 발생했습니다. 콘솔을 확인하세요.', { variant:'error' }); }
});

// Import lists from a backup JSON file
els.importListsBtn?.addEventListener('click', ()=>{ try{ els.importListsInput?.click(); }catch(e){ console.warn('open import file picker failed', e); } });

els.importListsInput?.addEventListener('change', async (e)=>{
  const f = e.target.files && e.target.files[0];
  if(!f) return;
  try{
    const txt = await new Promise((res, rej)=>{ const fr = new FileReader(); fr.onload = ()=>res(fr.result); fr.onerror = ()=>rej(fr.error); fr.readAsText(f); });
    let parsed = null;
  try{ parsed = JSON.parse(txt); }catch(err){ showToast('파일이 유효한 JSON이 아닙니다.', { variant:'error' }); return; }
    if(!parsed || !Array.isArray(parsed.lists) && !Array.isArray(parsed)){
      // support either {lists: [...] } or an array root
      if(Array.isArray(parsed)) parsed = { lists: parsed };
  else { showToast('백업 형식이 예상과 다릅니다. (배열 또는 {lists: [...]})', { variant:'warn' }); return; }
    }
    const incoming = parsed.lists || [];
    if(!incoming.length){ if(!confirm('불러온 백업이 비어 있습니다. 계속하시겠습니까?')) return; }
    // Ask whether to replace or append/merge
    const replace = confirm('목록을 완전히 교체하려면 확인(예)을 누르세요. 병합하려면 취소를 누르세요.');
    if(replace){
      // sanitize incoming lists to enforce max depth and promote PDF leaves
      state.userLists = sanitizeImportedLists(incoming);
    } else {
      // Simple merge: append incoming top-level lists that don't have an id collision
      const sanitized = sanitizeImportedLists(incoming);
      for(const it of sanitized){
        if(!it || !it.id){ it.id = crypto.randomUUID(); }
        if(!findNodeById(state.userLists, it.id)){
          state.userLists.push(it);
        } else {
          const clone = JSON.parse(JSON.stringify(it)); clone.id = crypto.randomUUID(); state.userLists.push(clone);
        }
      }
    }
    // persist and bump version
    try{ await saveLists(); }catch(e){ console.warn('saveLists after import failed', e); }
    try{ const cur = (await dbGet('userListsVersion')) || 0; await dbPut('userListsVersion', Number(cur) + 1); }catch(e){ console.warn('bump version after import failed', e); }
    renderSidebar(); renderListContents();
    try{ if(typeof window.broadcastUserListsUpdated === 'function'){ window.broadcastUserListsUpdated(); } }catch(e){ console.warn('broadcast failed', e); }
    showToast('백업 불러오기 완료.', { variant:'info' });
  }catch(err){ console.warn('import failed', err); showToast('백업 불러오기 중 오류가 발생했습니다. 콘솔을 확인하세요.', { variant:'error' }); }
  // clear input so the same file can be reselected later
  try{ e.target.value = ''; }catch(_){ }
});

// pdf upload/viewer handlers
// PDF 파일 처리 (간소화)
els.pdfInput?.addEventListener('change', (e) => {
  console.log('🔥 파일 선택 이벤트 발생');
  const f = e.target.files && e.target.files[0];
  console.log('🔥 선택된 파일:', f);
  console.log('🔥 pendingPdfParentId:', pendingPdfParentId);
  if (f) {
    handlePdfFile(f, pendingPdfParentId);
  } else {
    console.warn('❌ 파일이 선택되지 않았습니다');
  }
  e.target.value = '';
  pendingPdfParentId = null;
});
els.closePdf?.addEventListener('click', ()=> closePdfViewer());

// 출판사 검색 페이지 열기
// 출판사별 검색 기능
els.publisherSearchBtn = document.getElementById('publisherSearchBtn');
els.publisherSearchBtn?.addEventListener('click', ()=> {
  const query = state.q?.trim() || '';
  
  // 원래의 간단한 모달 방식 사용
  showPublisherSearchMenu(query);
});

// 출판사별 검색 메뉴 표시
function showPublisherSearchMenu(query) {
  // 기본 출판사들 (publisher-manager.js 로드 전 fallback)
  const defaultPublishers = [
    { id: 'nature', name: 'Nature', logo: '🧬', url: `https://www.nature.com/search?q=${encodeURIComponent(query)}`, color: '#0f7b7e' },
    { id: 'science', name: 'Science', logo: '🔬', url: `https://www.science.org/action/doSearch?text1=${encodeURIComponent(query)}`, color: '#1f4e79' },
    { id: 'elsevier', name: 'Elsevier', logo: '�', url: `https://www.sciencedirect.com/search?qs=${encodeURIComponent(query)}`, color: '#ff6c00' },
    { id: 'springer', name: 'Springer', logo: '🌿', url: `https://link.springer.com/search?query=${encodeURIComponent(query)}`, color: '#004b87' },
    { id: 'wiley', name: 'Wiley', logo: '📖', url: `https://onlinelibrary.wiley.com/action/doSearch?AllField=${encodeURIComponent(query)}`, color: '#1e3a8a' }
  ];

  // PublisherManager가 로드되어 있으면 사용, 아니면 기본 출판사 사용
  let publishers = defaultPublishers;
  if (window.PublisherManager && window.PublisherManager.loaded) {
    try {
      const allPublishers = window.PublisherManager.getAllPublishers();
      publishers = allPublishers.map(pub => ({
        id: pub.id,
        name: pub.shortName,
        logo: pub.logo,
        color: pub.color,
        url: window.PublisherManager.generateSearchUrl(pub.id, query),
        access: pub.access,
        openAccess: pub.openAccess
      }));
    } catch (error) {
      console.warn('Failed to load publisher data, using defaults:', error);
    }
  }

  let selectedPublishers = state.selectedPublishers;

  // 메뉴 HTML 생성 함수
  function generateMenuHtml() {
    return publishers.map(pub => {
      const isSelected = selectedPublishers.has(pub.id);
      const accessBadge = pub.access ? `<span class="publisher-access-badge ${pub.access}">${pub.access === 'open' ? '무료' : '유료'}</span>` : '';
      
      return `<button class="publisher-search-item ${isSelected ? 'selected' : ''}" 
                      onclick="togglePublisherSelection('${pub.id}')" 
                      title="${pub.name}에서 검색 (클릭하여 선택/해제)">
        <span class="publisher-search-logo" style="background-color: ${pub.color}">${pub.logo}</span>
        <span class="publisher-search-name">${pub.name}</span>
        ${accessBadge}
        ${isSelected ? '<span class="selection-indicator">✓</span>' : ''}
      </button>`;
    }).join('');
  }

  // 출판사 선택 토글 함수 (전역)
  window.togglePublisherSelection = function(publisherId) {
    console.log('🏢 출판사 선택/해제:', publisherId);
    console.log('🏢 변경 전 state.selectedPublishers:', Array.from(state.selectedPublishers || []));
    
    if (selectedPublishers.has(publisherId)) {
      selectedPublishers.delete(publisherId);
      console.log('🏢 출판사 제거됨:', publisherId);
    } else {
      selectedPublishers.add(publisherId);
      console.log('🏢 출판사 추가됨:', publisherId);
    }
    
    console.log('🏢 변경 후 state.selectedPublishers:', Array.from(state.selectedPublishers || []));
    
    // 메뉴 업데이트
    const grid = document.querySelector('.publisher-search-grid');
    if (grid) {
      grid.innerHTML = generateMenuHtml();
    }
    
    // 선택된 출판사 표시 업데이트
    window.updateSelectedPublishersDisplay();
  };

  // 액션 버튼 상태 업데이트 (더 이상 사용하지 않음)
  // function updateActionButtons() { ... }

  // 전체 선택/해제
  window.selectAllPublishers = function() {
    if (selectedPublishers.size === publishers.length) {
      selectedPublishers.clear();
    } else {
      publishers.forEach(pub => selectedPublishers.add(pub.id));
    }
    
    const grid = document.querySelector('.publisher-search-grid');
    if (grid) {
      grid.innerHTML = generateMenuHtml();
    }
    window.updateSelectedPublishersDisplay();
  };

  // 선택된 출판사 표시 업데이트 함수
  window.updateSelectedPublishersDisplay = function() {
    const displayElement = document.getElementById('selectedPublishersDisplay');
    const logosElement = document.getElementById('selectedPublisherLogos');
    
    // 현재 로드된 출판사 정보 가져오기
    let availablePublishers = [];
    if (window.PublisherManager && window.PublisherManager.loaded) {
      try {
        availablePublishers = window.PublisherManager.getAllPublishers();
      } catch (error) {
        console.warn('Failed to get publishers for display:', error);
      }
    }
    
    // 기본 출판사 정보 (fallback)
    if (availablePublishers.length === 0) {
      availablePublishers = [
        { id: 'nature', shortName: 'Nature', logo: '🧬', color: '#0f7b7e' },
        { id: 'science', shortName: 'Science', logo: '🔬', color: '#1f4e79' },
        { id: 'elsevier', shortName: 'Elsevier', logo: '📚', color: '#ff6c00' },
        { id: 'springer', shortName: 'Springer', logo: '🌿', color: '#004b87' },
        { id: 'wiley', shortName: 'Wiley', logo: '📖', color: '#1e3a8a' }
      ];
    }
    
    const selectedPubs = availablePublishers.filter(pub => state.selectedPublishers.has(pub.id));
    
    // 검색어 옆 로고 영역 업데이트
    if (logosElement) {
      if (selectedPubs.length === 0) {
        logosElement.innerHTML = '';
      } else {
        const logoHtml = selectedPubs.map(pub => {
          return `<div class="selected-publisher-logo" 
                       style="background-color: ${pub.color || '#f0f0f0'};" 
                       title="${pub.shortName || pub.name}"
                       onclick="togglePublisherSelection('${pub.id}')">
                    ${pub.logo || pub.shortName?.charAt(0) || '?'}
                  </div>`;
        }).join('');
        logosElement.innerHTML = logoHtml;
      }
    }
    
    // 기존 display 영역도 업데이트
    if (displayElement) {
      if (selectedPubs.length === 0) {
        displayElement.innerHTML = '';
        return;
      }
      
      // 선택된 모든 출판사를 표시하도록 변경 (더보기 +N 표시 제거)
      // 필요하면 이 동작을 다시 제한하거나 접기/툴팁으로 대체할 수 있습니다.
      const html = selectedPubs.map(pub => 
        `<div class="selected-publisher-logo" style="background-color: ${pub.color || '#f0f0f0'}" title="${pub.shortName || pub.name}">
          ${pub.logo}
        </div>`
      ).join('');

      displayElement.innerHTML = html;
    }
  };

  // 메뉴 HTML 생성
  const menuHtml = publishers.map(pub => 
    `<button class="publisher-search-item" onclick="window.open('${pub.url}', '_blank')" title="${pub.name}에서 검색">
      <span class="publisher-search-logo" style="background-color: ${pub.color}">${pub.logo}</span>
      <span class="publisher-search-name">${pub.name}</span>
      ${pub.access ? `<span class="publisher-access-badge ${pub.access}">${pub.access === 'open' ? '무료' : '유료'}</span>` : ''}
    </button>`
  ).join('');

  // 모달 다이얼로그로 메뉴 표시
  const modal = document.createElement('div');
  modal.className = 'publisher-search-modal';
  modal.innerHTML = `
    <div class="publisher-search-overlay" onclick="this.parentElement.remove()"></div>
    <div class="publisher-search-dialog">
      <div class="publisher-search-header">
        <h3>📚 출판사별 검색</h3>
        <button class="publisher-search-close" onclick="this.closest('.publisher-search-modal').remove()">×</button>
      </div>
      <div class="publisher-search-grid">
        ${generateMenuHtml()}
      </div>
      <div class="publisher-search-footer">
        <button onclick="selectAllPublishers()" class="btn btn-ghost">모두 선택</button>
        <button onclick="clearAllPublishers()" class="btn btn-ghost">모두 해제</button>
        <button onclick="applyPublisherSelection()" class="btn btn-primary">적용</button>
      </div>
    </div>
  `;

  // 스타일 추가 (한 번만)
  if (!document.getElementById('publisher-search-styles')) {
    const styles = document.createElement('style');
    styles.id = 'publisher-search-styles';
    styles.textContent = `
      .publisher-search-modal {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: 10000;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .publisher-search-overlay {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.5);
        cursor: pointer;
      }
      .publisher-search-dialog {
        position: relative;
        background: white;
        border-radius: 15px;
        box-shadow: 0 15px 40px rgba(0, 0, 0, 0.3);
        max-width: 600px;
        width: 90vw;
        max-height: 80vh;
        overflow: hidden;
      }
      .publisher-search-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 25px;
        border-bottom: 1px solid #eee;
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color: white;
      }
      .publisher-search-header h3 {
        margin: 0;
        font-size: 20px;
      }
      .publisher-search-close {
        background: none;
        border: none;
        font-size: 28px;
        cursor: pointer;
        color: white;
        padding: 0;
        width: 35px;
        height: 35px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        transition: background 0.2s;
      }
      .publisher-search-close:hover {
        background: rgba(255, 255, 255, 0.2);
      }
      .publisher-search-query {
        padding: 20px 25px;
        background: #f8f9fa;
        border-bottom: 1px solid #eee;
        color: #666;
        font-size: 15px;
      }
      .publisher-search-grid {
        padding: 25px;
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 12px;
        max-height: 400px;
        overflow-y: auto;
      }
      .publisher-search-footer {
        padding: 20px 25px;
        border-top: 1px solid #eee;
        display: flex;
        gap: 10px;
        justify-content: flex-end;
        background: #f8f9fa;
      }
      .publisher-search-item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 12px;
        border: 2px solid #e1e8ed;
        border-radius: 10px;
        background: white;
        cursor: pointer;
        transition: all 0.3s;
        text-align: left;
        font-size: 13px;
        color: #333;
        position: relative;
      }
      .publisher-search-item:hover {
        border-color: #667eea;
        background: #f8f9ff;
        transform: translateY(-3px);
        box-shadow: 0 8px 20px rgba(0, 0, 0, 0.15);
      }
      .publisher-search-item.selected {
        border-color: #27ae60;
        background: #d5f4e6;
        transform: translateY(-2px);
        box-shadow: 0 5px 15px rgba(39, 174, 96, 0.3);
      }
      .publisher-search-item.selected:hover {
        border-color: #2ecc71;
        background: #abebc6;
      }
      .selection-indicator {
        position: absolute;
        top: 8px;
        right: 8px;
        background: #27ae60;
        color: white;
        border-radius: 50%;
        width: 20px;
        height: 20px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 12px;
        font-weight: bold;
      }
      .btn {
        padding: 8px 16px;
        border: none;
        border-radius: 8px;
        cursor: pointer;
        font-size: 14px;
        font-weight: 500;
        transition: all 0.2s;
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .btn-sm {
        padding: 6px 12px;
        font-size: 13px;
      }
      .btn-primary {
        background: #007bff;
        color: white;
      }
      .btn-primary:hover:not(:disabled) {
        background: #0056b3;
      }
      .btn-success {
        background: #28a745;
        color: white;
      }
      .btn-success:hover {
        background: #218838;
      }
      .btn-secondary {
        background: #6c757d;
        color: white;
      }
      .btn-secondary:hover {
        background: #545b62;
      }
      .publisher-search-logo {
        font-size: 20px;
        flex-shrink: 0;
        width: 36px;
        height: 36px;
        border-radius: 8px;
        display: flex;
        align-items: center;
        justify-content: center;
        color: white;
        font-weight: bold;
      }
      .publisher-search-name {
        font-weight: 600;
        flex: 1;
      }
      .publisher-access-badge {
        position: absolute;
        top: 8px;
        right: 8px;
        padding: 2px 6px;
        border-radius: 8px;
        font-size: 10px;
        font-weight: bold;
        text-transform: uppercase;
      }
      .publisher-access-badge.open {
        background: #d5f4e6;
        color: #27ae60;
      }
      .publisher-access-badge.subscription {
        background: #fadbd8;
        color: #e74c3c;
      }
      .publisher-access-badge.mixed {
        background: #fef3cd;
        color: #f39c12;
      }
      @media (max-width: 600px) {
        .publisher-search-grid {
          grid-template-columns: 1fr;
        }
      }
    `;
    document.head.appendChild(styles);
  }

  document.body.appendChild(modal);
  
  // ESC 키로 닫기
  const handleEsc = (e) => {
    if (e.key === 'Escape') {
      modal.remove();
      document.removeEventListener('keydown', handleEsc);
    }
  };
  document.addEventListener('keydown', handleEsc);
}

async function search(){
  console.log('🔍 검색 시작 - 실제 API 호출:', { q: state.q, sort: state.sort, page: state.page, selectedPublishers: state.selectedPublishers });
  
  try {
    // 출판사 데이터 로드
    await loadPublishersData();
    
    // 검색어 확인
    if (!state.q || !state.q.trim()) {
      console.log('🔍 검색어 없음 - 빈 결과 표시');
      state.items = [];
      state.total = 0;
      state.hasSearched = false;
      renderResults();
      return;
    }

    // 백엔드 API 호출을 위한 파라미터 구성
    const params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.sort && state.sort !== 'relevance') params.set('sort', state.sort);
    if (state.page && state.page !== 1) params.set('page', state.page);
    if (state.pageSize) params.set('pageSize', state.pageSize);
    if (state.yFrom) params.set('yFrom', state.yFrom);
    if (state.yTo) params.set('yTo', state.yTo);
    if (state.journal) params.set('journal', state.journal);
    
    // 출판사 필터링을 위한 source 파라미터 결정
    let source = 'all'; // 기본적으로 모든 소스 검색
    if (state.selectedPublishers && state.selectedPublishers.size > 0) {
      // 선택된 출판사에 따라 source 결정
      const selectedPublisherIds = Array.from(state.selectedPublishers);
      if (selectedPublisherIds.includes('arxiv')) {
        source = 'arxiv';
      } else if (selectedPublisherIds.includes('crossref')) {
        source = 'crossref';
      }
      // 여러 출판사가 선택된 경우 all 사용
    }
    params.set('source', source);

    const apiUrl = `http://localhost:3001/api/search?${params.toString()}`;
    console.log('🌐 백엔드 API 호출:', apiUrl);

    const response = await fetch(apiUrl);
    if (!response.ok) {
      throw new Error(`API 호출 실패: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    console.log('✅ API 응답 수신:', { total: data.total, itemsCount: data.items?.length || 0 });

    if (data.ok) {
      // 출판사 정보 추가
      const itemsWithPublishers = data.items.map(item => {
        // 저널 이름으로 출판사 찾기
        const publisher = findPublisherByJournal(item.journal);
        return {
          ...item,
          publisher: publisher ? {
            id: publisher.id,
            name: publisher.shortName || publisher.name,
            logo: publisher.logo,
            color: publisher.color
          } : { name: 'Unknown Publisher', id: 'unknown' },
          api: source,
          searchUrl: `https://scholar.google.com/scholar?q=${encodeURIComponent(state.q)}`,
          id: `${source}_${item.id}`
        };
      });

      state.items = itemsWithPublishers;
      state.total = data.total;
      state.hasSearched = true;

      console.log('� 검색 결과 처리 완료:', { total: state.total, items: state.items.length });
    } else {
      throw new Error(data.error || 'API 응답 오류');
    }

    // 결과 표시
    renderResults();
    renderChips();
    
    // 검색 결과 저장
    saveSearchResults();

  } catch (error) {
    console.error('❌ 검색 실패:', error);
    showToast('검색 중 오류가 발생했습니다: ' + error.message, 'error');
    state.items = [];
    state.total = 0;
    state.hasSearched = false;
    renderResults();
  }
}

// 검색 결과를 localStorage에 저장
function saveSearchResults() {
  try {
    const searchData = {
      hasSearched: state.hasSearched,
      q: state.q,
      sort: state.sort,
      page: state.page,
      total: state.total,
      items: state.items,
      yFrom: state.yFrom,
      yTo: state.yTo,
      journal: state.journal,
      timestamp: Date.now()
    };
    localStorage.setItem('paperscout_search_results', JSON.stringify(searchData));
    console.log('💾 검색 결과 저장됨:', searchData);
  } catch (error) {
    console.warn('검색 결과 저장 실패:', error);
  }
}

// localStorage에서 검색 결과 복원
function restoreSearchResults() {
  try {
    // 복원 방지 플래그 확인
    if (window._preventRestore) {
      console.log('🚫 복원이 방지됨 (로고 클릭으로 인한 초기화)');
      return false;
    }
    
    const savedData = localStorage.getItem('paperscout_search_results');
    if (!savedData) return false;
    
    const searchData = JSON.parse(savedData);
    
    // 24시간 이내의 데이터만 복원
    if (Date.now() - searchData.timestamp > 24 * 60 * 60 * 1000) {
      localStorage.removeItem('paperscout_search_results');
      return false;
    }
    
    // 상태 복원
    state.hasSearched = searchData.hasSearched;
    state.q = searchData.q || "";
    state.sort = searchData.sort || "relevance";
    state.page = searchData.page || 1;
    state.total = searchData.total || 0;
    state.items = searchData.items || [];
    state.yFrom = searchData.yFrom || "";
    state.yTo = searchData.yTo || "";
    state.journal = searchData.journal || "";
    
    // 폼 필드 복원
    if (els.q) els.q.value = state.q;
    if (els.sort) els.sort.value = state.sort;
    if (els.yFrom) els.yFrom.value = state.yFrom;
    if (els.yTo) els.yTo.value = state.yTo;
    if (els.journal) els.journal.value = state.journal;
    
    console.log('🔄 검색 결과 복원됨:', searchData);
    return true;
  } catch (error) {
    console.warn('검색 결과 복원 실패:', error);
    localStorage.removeItem('paperscout_search_results');
    return false;
  }
}

function setFromForm(){
  try{ state.q = (els.q && typeof els.q.value === 'string') ? els.q.value.trim() : ""; }catch(e){ state.q = ""; }
  try{ state.sort = (els.sort && typeof els.sort.value === 'string') ? els.sort.value : "relevance"; }catch(e){ state.sort = "relevance"; }
  try{ state.yFrom = (els.yFrom && typeof els.yFrom.value === 'string') ? els.yFrom.value.trim() : ""; }catch(e){ state.yFrom = ""; }
  try{ state.yTo = (els.yTo && typeof els.yTo.value === 'string') ? els.yTo.value.trim() : ""; }catch(e){ state.yTo = ""; }
  try{ state.journal = (els.journal && typeof els.journal.value === 'string') ? els.journal.value.trim() : ""; }catch(e){ state.journal = ""; }
  
  console.log('🔍 폼 값 설정됨:', { 
    q: state.q, 
    sort: state.sort, 
    yFrom: state.yFrom, 
    yTo: state.yTo, 
    journal: state.journal 
  });
}

els.form?.addEventListener("submit",(e)=>{
  console.log('🔍 검색 폼 제출됨');
  console.log('🔍 Form element:', els.form);
  console.log('🔍 Event:', e);
  e.preventDefault(); 
  console.log('🔍 setFromForm 호출 전');
  setFromForm(); 
  console.log('🔍 state.page=1 설정');
  state.page=1; 
  console.log('🔍 search-results.html 페이지로 이동');
  
  // 검색 파라미터 구성
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.sort && state.sort !== 'relevance') params.set('sort', state.sort);
  if (state.yFrom) params.set('yFrom', state.yFrom);
  if (state.yTo) params.set('yTo', state.yTo);
  if (state.journal) params.set('journal', state.journal);
  
  // 출판사 필터링 파라미터 추가
  if (state.selectedPublishers && state.selectedPublishers.size > 0) {
    params.set('publishers', Array.from(state.selectedPublishers).join(','));
  }
  
  // search-results.html 페이지로 이동
  const searchUrl = `search-results.html?${params.toString()}`;
  console.log('🔍 검색 결과 페이지로 이동:', searchUrl);
  window.location.href = searchUrl;
});

// 정렬 드롭다운 변경 시 자동 재검색
els.sort?.addEventListener('change', () => {
  console.log('🔄 정렬 옵션 변경됨:', els.sort.value);
  if (state.hasSearched && state.q) {
    setFromForm();
    state.page = 1; // 첫 페이지로 리셋
    search();
  }
});

// 🔥 브라우저 히스토리 변경 감지 (뒤로가기/앞으로가기)
window.addEventListener('popstate', () => {
  console.log('🔄 브라우저 히스토리 변경 감지');
  const sp = new URLSearchParams(location.search);
  const urlQuery = sp.get("q") || "";
  
  // URL에 검색어가 없을 때는 상태 초기화하지 않음 (검색 결과 유지)
  if (!urlQuery) {
    console.log('🧹 검색어 없음 - 상태는 유지');
    // state.hasSearched = false;
    // state.total = 0;
    // state.items = [];
    // state.q = "";
    // if(els.q) els.q.value = "";
    // renderResults();
  } else {
    // URL에 검색어가 있으면 해당 상태로 복원
    state.q = urlQuery;
    if(els.q) els.q.value = urlQuery;
    search();
  }
});

// 🔥 페이지 가시성 변경 감지 (다른 탭에서 돌아왔을 때 등)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    const sp = new URLSearchParams(location.search);
    const urlQuery = sp.get("q") || "";
    
    // 현재 상태와 URL이 일치하지 않으면 동기화
    if (state.q !== urlQuery) {
      console.log('🔄 페이지 가시성 변경 - 상태 동기화');
      if (!urlQuery) {
        // 검색 결과 유지 - 초기화하지 않음
        console.log('🔄 URL에 검색어 없음 - 상태 유지');
        // state.hasSearched = false;
        // state.total = 0;
        // state.items = [];
        // state.q = "";
        // if(els.q) els.q.value = "";
        // renderResults();
      }
    }
  }
});

// 🔥 검색 입력 필드 변화 감지
els.q?.addEventListener('input', (e) => {
  const value = e.target.value.trim();
  
  // 검색어가 완전히 지워지면 결과 숨기기
  if (!value) {
    console.log('🧹 검색어 지워짐 - 결과 숨기기');
    state.hasSearched = false;
    state.total = 0;
    state.items = [];
    state.q = "";
    renderResults();
  }
});

// 🔥 검색 폼 리셋 이벤트 감지
els.form?.addEventListener('reset', () => {
  console.log('🧹 폼 리셋 - 상태 초기화');
  setTimeout(() => { // 폼 리셋이 완료된 후 실행
    state.hasSearched = false;
    state.total = 0;
    state.items = [];
    state.q = "";
    state.page = 1;
    renderResults();
  }, 0);
});

// 북마크/도움말(열기만)
// 단축키: /, a, Esc
document.addEventListener("keydown",(e)=>{
  // defensive: some synthetic or platform events may lack `key` (undefined).
  // Normalize to an empty string and only call toLowerCase on a real string.
  const key = (e && typeof e.key === 'string') ? e.key : '';
  if(key === "/" && document.activeElement && document.activeElement.tagName !== "INPUT"){ e.preventDefault(); els.q.focus(); }
  const kl = key.toLowerCase();
  if(kl === "a"){ 
    const advancedOptions = document.getElementById("advancedOptions");
    const advancedToggle = document.getElementById("advancedToggle");
    if(advancedOptions && advancedToggle) {
      const isHidden = advancedOptions.style.display === 'none';
      advancedOptions.style.display = isHidden ? 'block' : 'none';
      advancedToggle.textContent = isHidden ? '간단' : '고급';
    }
  }
  if(key === "Escape"){ document.querySelectorAll("dialog[open]").forEach(d=>d.close()); }
});

// 초기화
(async function init(){
  // 🔥 MODAL 초기화: 페이지 로드 시 모든 모달 강제 닫기
  console.log('🔥 MODAL 초기화: 페이지 로드 시 모든 모달 강제 닫기');
  try {
    const publisherDialog = document.getElementById('publisherDialog');
    if (publisherDialog && publisherDialog.open) {
      console.log('📚 출판사 모달이 열려있음 - 강제 닫기');
      publisherDialog.close();
    }
  } catch (error) {
    console.warn('📚 모달 초기화 실패:', error);
  }
  
  if (!window.ListCore) {
    console.error('ListCore is required but not available');
    return;
  }
  
  // Initialize ListCore
  await window.ListCore.init();
  
  // 🔥 DEBUG: 요소들 확인
  console.log('🔍 DEBUG - Elements check:');
  console.log('addListBtn element:', els.addListBtn);
  console.log('newListName element:', els.newListName);
  console.log('addListBtn found by ID:', document.getElementById('addListBtn'));
  console.log('newListName found by ID:', document.getElementById('newListName'));
  
  // 임시 테스트 함수 (onclick 속성용)
  window.testAddList = async function() {
    const timestamp = Date.now();
    console.log('🔥🔥🔥 testAddList 시작:', timestamp);
    
    // 중복 호출 방지 체크
    if (window._addingList) {
      console.warn('⚠️ testAddList 이미 실행 중, 중복 호출 방지');
      return;
    }
    window._addingList = true;
    
    try {
      // 🔍 현재 상태 확인
      console.log('🔍 ADD LIST - Current state:');
      console.log('state.userLists length:', state.userLists?.length || 0);
      console.log('ListCore.state.lists length:', window.ListCore?.state?.lists?.length || 0);
      console.log('state.userLists:', JSON.stringify(state.userLists, null, 2));
      console.log('ListCore.state.lists:', JSON.stringify(window.ListCore?.state?.lists || [], null, 2));
      
      // 🔍 자식 목록 상세 확인
      console.log('🔍 CHILDREN CHECK:');
      state.userLists?.forEach((list, i) => {
        console.log(`List ${i}: ${list.name} has ${list.children?.length || 0} children`);
        if(list.children?.length > 0) {
          console.log(`  Children:`, list.children.map(c => c.name));
        }
      });
      window.ListCore?.state?.lists?.forEach((list, i) => {
        console.log(`ListCore List ${i}: ${list.name} has ${list.children?.length || 0} children`);
        if(list.children?.length > 0) {
          console.log(`  ListCore Children:`, list.children.map(c => c.name));
        }
      });
      
      const nameInput = document.getElementById('newListName');
      if (!nameInput) {
        console.error('❌ newListName 요소를 찾을 수 없습니다!');
        return;
      }
      
      const name = nameInput.value.trim();
      if (!name) {
        console.warn('⚠️ 목록 이름을 입력해주세요');
        alert('목록 이름을 입력해주세요');
        return;
      }
      
      if (!window.ListCore) {
        console.error('❌ ListCore가 없습니다!');
        alert('ListCore가 초기화되지 않았습니다');
        return;
      }
      
      console.log('📝 목록 추가 시도:', name, '시간:', timestamp);
      
      // 🔍 CRITICAL: ListCore의 현재 상태 보존 - 덮어쓰지 않음
      console.log('🔄 BEFORE addList: preserving current ListCore state...');
      console.log('✅ ListCore state preserved (not overwritten)');
      
      // 🔍 추가 전 상태
      console.log('🔍 BEFORE addList:');
      console.log('state.userLists length:', state.userLists.length);
      console.log('state.userLists:', JSON.stringify(state.userLists, null, 2));
      console.log('ListCore.state.lists length:', window.ListCore.state.lists.length);
      console.log('ListCore.state.lists:', JSON.stringify(window.ListCore.state.lists, null, 2));
      
      // 🔍 중요: 상태 동기화 확인
      console.log('🔍 state.userLists === ListCore.state.lists?', state.userLists === window.ListCore.state.lists);
      console.log('🔍 JSON 비교:', JSON.stringify(state.userLists) === JSON.stringify(window.ListCore.state.lists));
      
      await window.ListCore.addList(name);
      console.log('✅ ListCore.addList 완료! 시간:', Date.now() - timestamp, 'ms');
      
      // 🔍 추가 후 즉시 상태 동기화 - ListCore가 상태를 변경했을 수 있음
      console.log('🔄 AFTER addList: immediate state sync...');
      state.userLists = JSON.parse(JSON.stringify(window.ListCore.state.lists));
      state.selectedListId = window.ListCore.state.selectedId;
      console.log('✅ Immediate state sync completed after addList');
      
      // 🔍 추가 후 상태
      console.log('🔍 AFTER addList:');
      console.log('ListCore.state.lists length:', window.ListCore.state.lists.length);
      console.log('ListCore.state.lists:', JSON.stringify(window.ListCore.state.lists, null, 2));
      console.log('Updated state.userLists:', JSON.stringify(state.userLists, null, 2));
      
      nameInput.value = '';
      renderSidebar();
      renderListContents();
      // alert('목록이 추가되었습니다: ' + name); // 🔥 REMOVED: 알림 제거
      
    } catch (err) {
      console.error('❌ 목록 추가 실패:', err);
      alert('목록 추가에 실패했습니다: ' + err.message);
    } finally {
      window._addingList = false;
      console.log('🏁 testAddList 완료:', timestamp);
    }
  };
  // Ensure the Add button triggers testAddList in all cases (onclick attribute may be missing)
  try{
    if(els.addListBtn && typeof window.testAddList === 'function'){
      els.addListBtn.removeEventListener && els.addListBtn.removeEventListener('click', window.testAddList);
      els.addListBtn.addEventListener('click', (e)=>{ e.preventDefault(); window.testAddList(); });
    }
    // Also allow Enter key in the newListName input to submit
    const nameInputEl = document.getElementById('newListName');
    if(nameInputEl){ nameInputEl.addEventListener('keydown', (e)=>{ if(e.key === 'Enter'){ e.preventDefault(); window.testAddList(); } }); }
  }catch(e){ console.warn('Failed to attach addList handlers', e); }
  
  // Set up event listeners for real-time updates
  window.ListCore.on('stateChanged', (event) => {
    console.log('🔥 stateChanged 이벤트 수신:', event);
    console.log('🔥 stateChanged 타입:', event?.type);
    
    // 🔍 Deep copy로 상태 동기화 - 중첩된 자식 목록까지 보존
    console.log('🔄 BEFORE sync - state.userLists length:', state.userLists?.length || 0);
    console.log('🔄 BEFORE sync - ListCore.state.lists length:', window.ListCore.state.lists?.length || 0);
    
    // 🔄 CRITICAL: 완전한 deep copy로 상태 무결성 보장
    try {
      const newLists = JSON.parse(JSON.stringify(window.ListCore.state.lists || []));
      console.log('🔥 Deep copied lists:', newLists);
      
      // 🔍 데이터 무결성 검증
      if (Array.isArray(newLists)) {
        state.userLists = newLists;
        console.log('✅ state.userLists updated successfully');
      } else {
        console.warn('❌ newLists is not an array, keeping current state');
      }
      
      state.selectedListId = window.ListCore.state.selectedId;
      
      console.log('🔄 AFTER sync - state.userLists length:', state.userLists?.length || 0);
      console.log('🔄 AFTER sync - state.userLists:', JSON.stringify(state.userLists, null, 2));
      
      // Update UI immediately
      renderSidebar();
      renderListContents();
    } catch (e) {
      console.error('❌ Error during state sync:', e);
    }
  });
  
  window.ListCore.on('listAdded', (event) => {
    console.log('🔥 listAdded 이벤트 수신:', event);
    
    // 🔍 상태 동기화 확인
    console.log('🔄 listAdded - BEFORE sync:');
    console.log('state.userLists:', JSON.stringify(state.userLists, null, 2));
    console.log('ListCore.state.lists:', JSON.stringify(window.ListCore.state.lists, null, 2));
    
    // Clear input field immediately
    if (els.newListName) {
      els.newListName.value = '';
    }
    // Show feedback toast
    showToast('목록이 추가되었습니다.', { variant: 'info' });
  });
  
  // Load lists using ListCore
  await window.ListCore.loadLists();
  console.log('✅ ListCore.loadLists completed');
  
  // 🔍 로드 후 상태 상세 확인
  console.log('🔍 AFTER loadLists:');
  console.log('ListCore.state.lists:', JSON.stringify(window.ListCore.state.lists, null, 2));
  console.log('ListCore.state.selectedId:', window.ListCore.state.selectedId);

  // Initial sync with ListCore state
  state.userLists = JSON.parse(JSON.stringify(window.ListCore.state.lists));
  state.selectedListId = window.ListCore.state.selectedId;
  console.log('🔄 Initial sync completed');
  console.log('app.js state.userLists:', JSON.stringify(state.userLists, null, 2));

  // Ensure ListCore internal state matches app.js state (for move operations)
  window.ListCore.state.lists = JSON.parse(JSON.stringify(state.userLists));
  console.log('🔄 ListCore state re-synced');  // Initial render after loading lists
  renderSidebar();
  renderListContents();
  
  // 🔥 DISABLED: Auto-creation of test lists (remove for production)
  // If no lists exist, create some test lists for drag & drop testing
  if (false && (!state.userLists || state.userLists.length === 0)) {
    console.log('Creating test lists for drag & drop functionality');
    state.userLists = [
      { id: 'test-list-1', name: '📁 테스트 목록 1', children: [] },
      { id: 'test-list-2', name: '📁 테스트 목록 2', children: [
        { id: 'child-1', name: '📄 하위 항목 1', children: [] },
        { id: 'child-2', name: '📄 하위 항목 2', children: [] }
      ]},
      { id: 'test-list-3', name: '📁 테스트 목록 3', children: [] }
    ];
    state.selectedListId = 'test-list-1';
    
    // Save the test lists
    try {
      await saveLists();
      renderSidebar();
      renderListContents();
      showToast('드래그 앤 드롭 테스트를 위한 목록이 생성되었습니다.', { variant: 'info' });
    } catch(e) {
      console.warn('Failed to save test lists', e);
    }
  }
  
  // Run fileSignature migration once on startup to populate signatures for existing PDF nodes.
  try{ await migrateFillFileSignatures(); }catch(e){ console.warn('migrateFillFileSignatures threw', e); }
  // listen for external updates to userLists (from pdf-viewer or other windows)
  try{
    if(typeof BroadcastChannel !== 'undefined'){
      const bc = new BroadcastChannel('paperscout-sync');
      const windowId = APP_WINDOW_ID; // 각 창에 고유 ID (shared global)
      
      bc.onmessage = (ev)=>{
        console.log('🔥 BroadcastChannel message received:', ev.data);
        try{
          const d = ev && ev.data ? ev.data : null;
          // userLists update (ignore own sender)
          if(d && d.type === 'userLists-updated' && d.sender !== windowId){
            console.log('📡 External userLists update detected, reloading...');
            if(window.ListCore) {
              window.ListCore.loadLists().then(()=>{
                state.userLists = JSON.parse(JSON.stringify(window.ListCore.state.lists || []));
                state.selectedListId = window.ListCore.state.selectedId;
                renderSidebar(); renderListContents();
                console.log('✅ BroadcastChannel: ListCore 동기화 완료');
              }).catch(e => console.error('BroadcastChannel: ListCore 동기화 실패:', e));
            }
          }

          // sidebar collapsed state from other window
          if(d && d.type === 'sidebar-collapsed' && d.sender !== windowId){
            try{
              const side = document.getElementById('sidebar');
              const btn = document.getElementById('sidebarToggle');
              if(side && btn){
                if(d.collapsed) side.classList.add('collapsed'); else side.classList.remove('collapsed');
                btn.setAttribute('aria-expanded', String(!d.collapsed));
              }
              // persist locally as well
              try{ localStorage.setItem('ps_sidebar_collapsed', d.collapsed ? '1' : '0'); }catch(e){}
            }catch(e){ console.warn('apply sidebar-collapsed message failed', e); }
          }

        }catch(e){ console.warn('BroadcastChannel message handling failed', e); }
      };
      
      // 메시지 전송 시 sender ID 포함
      window.broadcastUserListsUpdated = function() {
        try {
          bc.postMessage({ type: 'userLists-updated', sender: windowId });
        } catch(e) {
          console.warn('BroadcastChannel message send failed', e);
        }
      };
    }
  }catch(e){ console.warn('BroadcastChannel init failed', e); }
  // initialize sidebar collapsed state from localStorage (apply on load)
  try{
    const v = localStorage.getItem('ps_sidebar_collapsed');
    if(v !== null){
      const side = document.getElementById('sidebar');
      const btn = document.getElementById('sidebarToggle');
      const collapsed = (v === '1' || v === 'true');
      if(side){ if(collapsed) side.classList.add('collapsed'); else side.classList.remove('collapsed'); }
      if(btn) btn.setAttribute('aria-expanded', String(!collapsed));
    }
  }catch(e){ console.warn('init sidebar collapsed state failed', e); }
  const sp = new URLSearchParams(location.search);
  if(els.q) els.q.value = sp.get("q") || "";
  if(els.sort) els.sort.value = sp.get("sort") || "relevance";
  if(els.yFrom) els.yFrom.value = sp.get("yFrom") || "";
  if(els.yTo) els.yTo.value = sp.get("yTo") || "";
  if(els.journal) els.journal.value = sp.get("journal") || "";
  
  // 🔥 상태 초기화 - URL 파라미터에서 값 설정
  state.q = sp.get("q") || "";
  state.sort = sp.get("sort") || "relevance";
  state.yFrom = sp.get("yFrom") || "";
  state.yTo = sp.get("yTo") || "";
  state.journal = sp.get("journal") || "";
  
  // 🔥 페이지 번호도 복원
  const urlPage = sp.get("page");
  if(urlPage && !isNaN(parseInt(urlPage))) {
    state.page = parseInt(urlPage);
  } else {
    state.page = 1;
  }
  
  // 🔥 검색어가 없을 때는 상태 초기화하지 않음 (검색 결과 유지)
  // if (!state.q) {
  //   state.hasSearched = false;
  //   state.total = 0;
  //   state.items = [];
  //   renderResults(); // 빈 결과로 렌더링
  // }
  
  setFromForm(); renderChips();
  
  // 🔥 URL 파라미터가 있으면 자동으로 검색 실행
  if(sp.get("q")) {
    console.log('🔍 URL 파라미터로부터 검색 상태 복원 및 검색 실행');
    search();
  } else {
    // 초기 상태 - 검색 전까지는 결과 표시하지 않음
    console.log('🔍 초기 상태 - 검색 대기 중');
    
    // 검색창과 상태 완전 초기화
    if(els.q) els.q.value = "";
    state.q = "";
    state.hasSearched = false;
    state.items = [];
    state.total = 0;
    
    renderResults(); // 빈 상태로 렌더링
  }
  
  renderSidebar();
  renderListContents();
  // static sidebar/tab support removed

  // delegated clicks inside listContents to open recent/bookmark entries and delete bookmarks
  try{
    els.listContents?.addEventListener('click', (e)=>{
      const row = e.target.closest('.list-row'); if(!row) return;
      // open
      if(e.target.closest('.js-open') || row.dataset.url){
        const url = row.dataset.url || null;
        if(url){ try{ window.location.href = createPdfViewerUrl(`url=${encodeURIComponent(url)}`); }catch(e){ window.open(url, '_blank'); } return; }
      }
      // delete bookmark
      if(e.target.closest('.js-delete')){
        const bid = row.dataset.bookmarkId || row.dataset.url; if(!bid) return; removeBookmark(bid); renderStaticTab('bookmarks'); showToast('북마크가 삭제되었습니다.', { variant:'info' }); return;
      }
      // clicking a simple list-row from library: select list
      if(row.dataset.id){ selectList(row.dataset.id); }
    });
  }catch(e){ console.warn('listContents handler setup failed', e); }
  // Fetch server-managed LLM config (public status endpoint) only when explicitly enabled.
  // Browsers will log a network error if no server is listening on localhost:5001; to avoid
  // noisy console messages in development setups where the admin server isn't running,
  // make the probe opt-in via localStorage key `llmProbe=true`.
  if(localStorage.getItem('llmProbe') === 'true'){
    (async ()=>{
      try{
        const controller = new AbortController();
        const timeout = setTimeout(()=> controller.abort(), 2000);
        const res = await fetch('http://localhost:5001/admin/llm/status', { signal: controller.signal });
        clearTimeout(timeout);
        if(res && res.ok){
          const data = await res.json().catch(()=>null);
          if(data && data.model){
            state.llmModel = data.model;
            state.llmForced = !!data.forced;
            console.info('[LLM] server model=', data.model, 'forced=', !!data.forced);
            // Surface a small UI hint in the title so devs notice the forced model
            if(state.llmForced){ document.title = `[LLM:${state.llmModel}] ` + (document.title||''); }
          }
        }
      }catch(e){ /* ignore fetch errors */ }
    })();
  }
  if(state.q) search();
  
  // 선택된 출판사 표시 초기화
  if (window.updateSelectedPublishersDisplay) {
    updateSelectedPublishersDisplay();
  }
  
  // 고급 검색 토글 기능 추가
  try {
    const advancedToggle = document.getElementById('advancedToggle');
    const advancedOptions = document.getElementById('advancedOptions');
    
    if (advancedToggle && advancedOptions) {
      advancedToggle.addEventListener('click', () => {
        const isHidden = advancedOptions.style.display === 'none';
        advancedOptions.style.display = isHidden ? 'block' : 'none';
        advancedToggle.textContent = isHidden ? '간단' : '고급';
      });
    }
  } catch (e) {
    console.warn('고급 검색 토글 설정 실패:', e);
  }
  
  // signal that the app finished initialization (helps automated tests wait reliably)
  try{ document.dispatchEvent(new CustomEvent('paperscout:ready')); }catch(e){}
  
  // 저장된 검색 결과 복원 시도
  // Only restore when we're on the search-results page or the URL contains a query param.
  try{
    const onSearchResultsPage = location.pathname && location.pathname.includes('search-results');
    const urlHasQuery = (new URLSearchParams(location.search)).has('q');
    if (onSearchResultsPage || urlHasQuery) {
      if (restoreSearchResults()) {
        console.log('✅ 이전 검색 결과 복원됨 (허용된 페이지/쿼리에서)');
        renderResults();
        renderChips();
      }
    } else {
      console.log('ℹ️ 검색 결과 복원 건너뜀: 현재 페이지는 인덱스이며 자동 복원을 하지 않습니다.');
    }
  }catch(e){ console.warn('restore guard failed', e); }
  
  // expose functions to window after definition to prevent infinite recursion
  window.renderSidebar = renderSidebar;
  window.renderListContents = renderListContents;
  
  // 🔥 MODAL 추가 안전장치: window.onload에서도 모달 강제 닫기
  window.addEventListener('load', () => {
    console.log('🔥 MODAL window.onload 초기화 시작');
    try {
      const publisherDialog = document.getElementById('publisherDialog');
      if (publisherDialog) {
        console.log('📚 window.onload 시점 모달 상태:', {
          open: publisherDialog.open,
          hidden: publisherDialog.hidden,
          display: window.getComputedStyle(publisherDialog).display
        });
        
        // 강제 닫기 시도
        if (publisherDialog.open) {
          publisherDialog.close();
          console.log('📚 window.onload 시점 모달 강제 닫기');
        }
        
        // 강제 숨김
        publisherDialog.hidden = true;
        publisherDialog.style.display = 'none';
        console.log('📚 window.onload 시점 모달 강제 숨김');
        
        // 승인 플래그 초기화
        window._allowModalOpen = false;
        window._modalLock = false;
        console.log('📚 window.onload 시점 승인 플래그 초기화');
      }
    } catch (error) {
      console.warn('📚 window.onload 모달 초기화 실패:', error);
    }
  });
  
  // 🔥 MODAL MutationObserver: modal이 열릴 때마다 강제로 닫기
  try {
    const publisherDialog = document.getElementById('publisherDialog');
    if (publisherDialog) {
      const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          console.log('📚 MutationObserver 감지:', mutation.type, mutation.attributeName, mutation.oldValue, '->', publisherDialog.getAttribute(mutation.attributeName));
          
          if (mutation.type === 'attributes') {
            if (mutation.attributeName === 'open') {
              const isOpen = publisherDialog.hasAttribute('open');
              console.log('📚 MutationObserver: modal open 속성 변경 감지 - open:', isOpen, '승인:', window._allowModalOpen, '잠금:', window._modalLock);
              
              // 🔥 자동으로 열리는 것을 방지하기 위해 바로 닫기
              if (isOpen && !window._allowModalOpen && !window._modalLock) {
                console.log('📚 MutationObserver: 승인되지 않은 modal 열림 감지 - 강제 닫기');
                setTimeout(() => {
                  try {
                    publisherDialog.close();
                    publisherDialog.hidden = true;
                    console.log('📚 MutationObserver: modal 강제 닫기 완료');
                  } catch (error) {
                    console.warn('📚 MutationObserver modal 닫기 실패:', error);
                  }
                }, 10);
              }
            } else if (mutation.attributeName === 'hidden') {
              const isHidden = publisherDialog.hasAttribute('hidden');
              console.log('📚 MutationObserver: modal hidden 속성 변경 감지 - hidden:', isHidden);
              
              // hidden이 false로 변경되면 강제로 true로 설정
              if (!isHidden && !window._allowModalOpen && !window._modalLock) {
                console.log('📚 MutationObserver: 승인되지 않은 modal 표시 감지 - 강제 숨김');
                setTimeout(() => {
                  try {
                    publisherDialog.hidden = true;
                    publisherDialog.close();
                    console.log('📚 MutationObserver: modal 강제 숨김 완료');
                  } catch (error) {
                    console.warn('📚 MutationObserver modal 숨김 실패:', error);
                  }
                }, 10);
              }
            }
          }
        });
      });
      
      // 🔥 모든 속성 변경 감시 (더 엄격하게)
      observer.observe(publisherDialog, {
        attributes: true,
        attributeFilter: ['open', 'hidden', 'style', 'class']
      });
      
      console.log('📚 MutationObserver 설정 완료 (엄격 모드)');
    }
  } catch (error) {
    console.warn('📚 MutationObserver 설정 실패:', error);
  }
})();

// 출판사 모달 관련 함수들
let publishersData = null;

// 🔥 MODAL 즉시 초기화: 스크립트 로드 시점에 모달 강제 닫기
(function() {
  console.log('🔥 MODAL 즉시 초기화 시작');
  try {
    const publisherDialog = document.getElementById('publisherDialog');
    if (publisherDialog) {
      console.log('📚 스크립트 로드 시점 모달 상태:', {
        exists: true,
        open: publisherDialog.open,
        hidden: publisherDialog.hidden,
        display: window.getComputedStyle ? window.getComputedStyle(publisherDialog).display : 'unknown'
      });
      
      // 강제 닫기 시도
      if (publisherDialog.open) {
        publisherDialog.close();
        console.log('📚 스크립트 로드 시점 모달 강제 닫기');
      }
      
      // 강제 숨김
      publisherDialog.hidden = true;
      publisherDialog.style.display = 'none';
      console.log('📚 스크립트 로드 시점 모달 강제 숨김');
      
      // 승인 플래그 초기화
      window._allowModalOpen = false;
      window._modalLock = false;
      console.log('📚 스크립트 로드 시점 승인 플래그 초기화');
    } else {
      console.log('📚 스크립트 로드 시점 모달 요소 없음');
    }
  } catch (error) {
    console.warn('🔥 MODAL 즉시 초기화 실패:', error);
  }
})();

// 출판사 데이터 로드
async function loadPublishersData() {
  if (!publishersData) {
    try {
      console.log('📚 출판사 데이터 로드 시작...');
      const response = await fetch('publishers.json');

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      publishersData = await response.json();
      console.log('📚 출판사 데이터 로드 완료:', {
        totalPublishers: publishersData?.publishers?.length || 0,
        hasPublishers: !!publishersData?.publishers,
        publishersDataKeys: Object.keys(publishersData || {}),
        firstPublisher: publishersData?.publishers?.[0]?.name
      });

      if (!publishersData.publishers || publishersData.publishers.length === 0) {
        console.warn('출판사 데이터가 비어있습니다');
      } else {
        console.log('📚 출판사 목록:');
        publishersData.publishers.forEach((pub, index) => {
          console.log(`  ${index + 1}. ${pub.name} (${pub.id}) - ${pub.journals?.length || 0}개 저널`);
        });
      }
    } catch (error) {
      console.error('출판사 데이터 로드 실패:', error);
      publishersData = { publishers: [] };
      showToast('출판사 데이터를 불러오는데 실패했습니다.', 'error');
    }
  } else {
    console.log('📚 출판사 데이터가 이미 로드되어 있음:', publishersData.publishers.length, '개');
  }
  return publishersData;
}

// 출판사 모달 표시
async function showPublisherModal() {
  console.log('📚 출판사 모달 표시 - 호출 스택:', new Error().stack);

  try {
    // 🔥 MODAL 열기 승인 플래그 설정
    window._allowModalOpen = true;
    console.log('📚 modal 열기 승인 플래그 설정');

    // 출판사 데이터 로드
    console.log('📚 출판사 데이터 로드 시작...');
    await loadPublishersData();
    console.log('📚 출판사 데이터 로드 완료');

    // 출판사 목록 렌더링
    console.log('📚 출판사 목록 렌더링 시작...');
    renderPublisherList();
    console.log('📚 출판사 목록 렌더링 완료');

    // 모달 표시
    const publisherDialog = document.getElementById('publisherDialog');
    if (publisherDialog) {
      console.log('📚 모달 열기 전 상태:', {
        open: publisherDialog.open,
        hidden: publisherDialog.hidden,
        display: window.getComputedStyle(publisherDialog).display,
        publisherListExists: !!document.getElementById('publisherList'),
        publisherListChildren: document.getElementById('publisherList')?.children?.length || 0
      });

      // 🔥 추가 안전장치: 다른 코드가 모달을 열지 못하도록 잠금
      window._modalLock = true;
      console.log('📚 modal 잠금 설정');

      publisherDialog.showModal();

      console.log('📚 모달 연 후 상태:', {
        open: publisherDialog.open,
        hidden: publisherDialog.hidden,
        display: window.getComputedStyle(publisherDialog).display
      });

      // 모달이 표시된 후에 이벤트 리스너 추가
      setTimeout(() => {
        console.log('📚 이벤트 리스너 설정 시작');

        // 기존 이벤트 리스너들을 정리하기 위해 모달에 데이터 속성으로 저장
        if (!publisherDialog._modalEventHandlers) {
          publisherDialog._modalEventHandlers = [];
        }

        // 이전 이벤트 리스너들 제거
        publisherDialog._modalEventHandlers.forEach(handler => {
          if (handler.element && handler.event && handler.func) {
            handler.element.removeEventListener(handler.event, handler.func);
          }
        });
        publisherDialog._modalEventHandlers = [];

        // 모달 배경 클릭으로 닫기
        const modalClickHandler = (e) => {
          console.log('📚 배경 클릭 이벤트 발생:', e.target, e.currentTarget);
          if (e.target === publisherDialog) {
            console.log('📚 모달 배경 클릭으로 닫기');
            hidePublisherModal();
          }
        };
        publisherDialog.addEventListener('click', modalClickHandler);
        publisherDialog._modalEventHandlers.push({
          element: publisherDialog,
          event: 'click',
          func: modalClickHandler
        });

        // 닫기 버튼들에 이벤트 리스너 추가
        const closeButtons = publisherDialog.querySelectorAll('.publisher-dialog__close');
        console.log('📚 닫기 버튼들 찾음:', closeButtons.length, '개');

        closeButtons.forEach((btn, index) => {
          const closeHandler = (e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log(`📚 닫기 버튼 ${index} 클릭`);
            hidePublisherModal();
          };
          btn.addEventListener('click', closeHandler);
          publisherDialog._modalEventHandlers.push({
            element: btn,
            event: 'click',
            func: closeHandler
          });
        });

        console.log('📚 이벤트 리스너 설정 완료');
      }, 100);

    } else {
      console.error('출판사 모달 요소를 찾을 수 없습니다');
    }
  } catch (error) {
    console.error('출판사 모달 표시 실패:', error);
    showToast('출판사 선택 기능을 사용할 수 없습니다.', 'error');
  } finally {
    // 🔥 MODAL 열기 승인 플래그 해제 (일정 시간 후)
    setTimeout(() => {
      window._allowModalOpen = false;
      window._modalLock = false;
      console.log('📚 modal 열기 승인 플래그 및 잠금 해제');
    }, 1000);
  }
}

// 출판사 모달 숨김
function hidePublisherModal() {
  console.log('📚 출판사 모달 숨김 시도 - 현재 상태:', {
    dialog: !!document.getElementById('publisherDialog'),
    open: document.getElementById('publisherDialog')?.open,
    hasCloseMethod: typeof document.getElementById('publisherDialog')?.close === 'function'
  });
  
  // 🔥 MODAL 열기 승인 플래그 해제
  window._allowModalOpen = false;
  console.log('📚 modal 열기 승인 플래그 해제');
  
  const publisherDialog = document.getElementById('publisherDialog');
  if (publisherDialog) {
    try {
      // 이벤트 리스너들 정리
      if (publisherDialog._modalEventHandlers) {
        console.log('📚 이벤트 리스너 정리:', publisherDialog._modalEventHandlers.length, '개');
        publisherDialog._modalEventHandlers.forEach(handler => {
          if (handler.element && handler.event && handler.func) {
            handler.element.removeEventListener(handler.event, handler.func);
          }
        });
        publisherDialog._modalEventHandlers = [];
      }
      
      // 모달 닫기 시도
      if (publisherDialog.open) {
        console.log('📚 dialog.close() 호출');
        publisherDialog.close();
      } else {
        console.log('📚 모달이 이미 닫혀있음');
      }
      
      // 🔥 추가 안전장치: 강제로 hidden 속성 설정
      publisherDialog.hidden = true;
      console.log('📚 modal hidden 속성 강제 설정');
      
      // 추가 확인
      setTimeout(() => {
        console.log('📚 모달 닫기 후 상태:', {
          open: publisherDialog.open,
          hidden: publisherDialog.hidden
        });
        
        // 🔥 최종 확인: 여전히 열려있으면 강제로 닫기
        if (publisherDialog.open) {
          console.log('📚 모달이 여전히 열려있음 - 최종 강제 닫기');
          try {
            publisherDialog.close();
            publisherDialog.hidden = true;
          } catch (error) {
            console.error('📚 최종 강제 닫기 실패:', error);
          }
        }
      }, 100);
      
    } catch (error) {
      console.error('📚 모달 닫기 실패:', error);
      // fallback: 강제로 hidden 속성 설정
      publisherDialog.style.display = 'none';
      publisherDialog.hidden = true;
      console.log('📚 fallback: display none 및 hidden 적용');
    }
  } else {
    console.error('📚 모달 요소를 찾을 수 없음');
  }
}

// 출판사 목록 렌더링
function renderPublisherList() {
  const publisherList = document.getElementById('publisherList');
  if (!publisherList || !publishersData) {
    console.error('출판사 목록 렌더링 실패: 요소 또는 데이터 없음', {
      publisherList: !!publisherList,
      publishersData: !!publishersData,
      publishersDataLength: publishersData?.publishers?.length
    });
    return;
  }

  console.log('📚 출판사 목록 렌더링 시작:', {
    totalPublishers: publishersData.publishers.length,
    publisherListElement: publisherList,
    currentHTML: publisherList.innerHTML.length
  });

  let html = '';

  if (publishersData.publishers && publishersData.publishers.length > 0) {
    console.log('📚 출판사 항목 생성 시작...');
    for (let i = 0; i < publishersData.publishers.length; i++) {
      const publisher = publishersData.publishers[i];
      const isChecked = (state.selectedPublishers && state.selectedPublishers.has(publisher.id)) ? 'checked' : '';
      const itemHtml = `
        <label class="publisher-item">
          <input type="checkbox" value="${publisher.id}" ${isChecked}>
          <span class="publisher-name">${escapeHtml(publisher.name)}</span>
          <span class="publisher-count">(${publisher.journals?.length || 0}개 저널)</span>
        </label>
      `;
      html += itemHtml;
      console.log(`📚 출판사 ${i + 1}/${publishersData.publishers.length}: ${publisher.name} (${publisher.journals?.length || 0}개 저널)`);
    }
    console.log('📚 출판사 항목 생성 완료, 총 HTML 길이:', html.length);
  } else {
    html = '<p>출판사 데이터를 불러올 수 없습니다.</p>';
    console.error('출판사 데이터가 비어있습니다:', publishersData);
  }

  publisherList.innerHTML = html;
  console.log('📚 HTML 적용 완료, publisherList 자식 요소 수:', publisherList.children.length);

  // 기존 이벤트 리스너 제거 후 새로 추가
  const newPublisherList = publisherList.cloneNode(true);
  publisherList.parentNode.replaceChild(newPublisherList, publisherList);
  document.getElementById('publisherList')._original = newPublisherList;

  // 체크박스 이벤트 리스너 추가
  newPublisherList.addEventListener('change', (e) => {
    if (e.target.type === 'checkbox') {
      const publisherId = e.target.value;
      // state.selectedPublishers가 초기화되지 않은 경우 초기화
      if (!state.selectedPublishers) {
        state.selectedPublishers = new Set();
      }
      if (e.target.checked) {
        state.selectedPublishers.add(publisherId);
      } else {
        state.selectedPublishers.delete(publisherId);
      }
      console.log('📚 선택된 출판사 업데이트:', Array.from(state.selectedPublishers));
    }
  });

  console.log('📚 출판사 목록 렌더링 완료');
}

// 모두 선택
function selectAllPublishers() {
  if (!publishersData || !publishersData.publishers) return;
  
  if (state.selectedPublishers && state.selectedPublishers.size === publishersData.publishers.length) {
    // 모두 선택되어 있으면 모두 해제
    state.selectedPublishers.clear();
  } else {
    // 모두 선택
    state.selectedPublishers = new Set(publishersData.publishers.map(p => p.id));
  }
  
  renderPublisherList();
}

// 모두 해제
function clearAllPublishers() {
  if (!state.selectedPublishers) {
    state.selectedPublishers = new Set();
  } else {
    state.selectedPublishers.clear();
  }
  
  renderPublisherList();
}

// 출판사 선택 적용
function applyPublisherSelection() {
  console.log('📚 출판사 선택 적용:', Array.from(state.selectedPublishers || []));
  
  // URL 업데이트
  updateUrlWithPublishers();
  
  // 모달 닫기
  hidePublisherModal();
  
  // 검색 재실행 (선택된 출판사가 있으면)
  if (state.selectedPublishers && state.selectedPublishers.size > 0) {
    search();
  }
  
  showToast('출판사 필터가 적용되었습니다.');
}

// URL에 출판사 파라미터 추가
function updateUrlWithPublishers() {
  const params = new URLSearchParams(window.location.search);
  
  if (state.selectedPublishers && state.selectedPublishers.size > 0) {
    params.set('publishers', Array.from(state.selectedPublishers).join(','));
  } else {
    params.delete('publishers');
  }
  
  // 다른 파라미터들도 유지
  if (state.q) params.set('q', state.q);
  if (state.sort !== 'relevance') params.set('sort', state.sort);
  if (state.page !== 1) params.set('page', state.page);
  if (state.yFrom) params.set('yFrom', state.yFrom);
  if (state.yTo) params.set('yTo', state.yTo);
  if (state.journal) params.set('journal', state.journal);
  
  const newUrl = `${window.location.pathname}?${params.toString()}`;
  history.replaceState({}, '', newUrl);
}

// 출판사 버튼 이벤트 리스너 설정
document.addEventListener('DOMContentLoaded', () => {
  // 🔥 MODAL 강제 초기화: DOMContentLoaded 시점에 모든 모달 강제 닫기
  console.log('🔥 MODAL 강제 초기화: DOMContentLoaded 시점에 모든 모달 강제 닫기');
  try {
    const publisherDialog = document.getElementById('publisherDialog');
    if (publisherDialog && publisherDialog.open) {
      console.log('📚 출판사 모달이 열려있음 - 강제 닫기');
      publisherDialog.close();
    }
    // 추가 안전장치: modal이 다시 열리지 않도록 hidden 속성도 설정
    if (publisherDialog && !publisherDialog.hidden) {
      publisherDialog.hidden = true;
      console.log('📚 출판사 모달 hidden 속성 설정');
    }
  } catch (error) {
    console.warn('📚 DOMContentLoaded 모달 초기화 실패:', error);
  }
  
  const publishersBtn = document.getElementById('publishersBtn');
  if (publishersBtn) {
    console.log('📚 출판사 버튼 이벤트 리스너 등록');
    publishersBtn.addEventListener('click', (e) => {
      e.preventDefault();
      console.log('📚 출판사 버튼 클릭');
      showPublisherModal();
    });
  } else {
    console.warn('⚠️ 출판사 버튼을 찾을 수 없습니다');
  }

  // 검색 폼의 출판사 선택 버튼도 이벤트 리스너 추가
  const publisherSearchBtn = document.getElementById('publisherSearchBtn');
  if (publisherSearchBtn) {
    console.log('📚 검색 폼 출판사 선택 버튼 이벤트 리스너 등록');
    publisherSearchBtn.addEventListener('click', (e) => {
      e.preventDefault();
      console.log('📚 검색 폼 출판사 선택 버튼 클릭');
      showPublisherModal();
    });
  } else {
    console.warn('⚠️ 검색 폼 출판사 선택 버튼을 찾을 수 없습니다');
  }

  // 출판사 모달 닫기 이벤트 리스너들
  const publisherDialog = document.getElementById('publisherDialog');
  if (publisherDialog) {
    console.log('📚 출판사 모달 닫기 이벤트 리스너 등록');
    
    // ESC 키로 모달 닫기
    const escKeyHandler = (e) => {
      console.log('📚 키보드 이벤트:', e.key, '모달 상태:', {
        open: publisherDialog?.open,
        hidden: publisherDialog?.hidden
      });
      
      if (e.key === 'Escape' && publisherDialog && !publisherDialog.hidden && publisherDialog.open) {
        e.preventDefault();
        console.log('📚 ESC 키로 모달 닫기');
        hidePublisherModal();
      }
    };
    document.addEventListener('keydown', escKeyHandler);
    
  } else {
    console.warn('⚠️ 출판사 모달을 찾을 수 없습니다');
  }

  // 출판사 적용 버튼
  const applyPublisherSelectionBtn = document.getElementById('applyPublisherSelection');
  if (applyPublisherSelectionBtn) {
    console.log('📚 출판사 적용 버튼 이벤트 리스너 등록');
    applyPublisherSelectionBtn.addEventListener('click', (e) => {
      e.preventDefault();
      applyPublisherSelection();
    });
  } else {
    console.warn('⚠️ 출판사 적용 버튼을 찾을 수 없습니다');
  }

  // 모두 선택 버튼
  const selectAllPublishersBtn = document.getElementById('selectAllPublishers');
  if (selectAllPublishersBtn) {
    console.log('📚 모두 선택 버튼 이벤트 리스너 등록');
    selectAllPublishersBtn.addEventListener('click', (e) => {
      e.preventDefault();
      selectAllPublishers();
    });
  }

  // 모두 해제 버튼
  const clearAllPublishersBtn = document.getElementById('clearAllPublishers');
  if (clearAllPublishersBtn) {
    console.log('📚 모두 해제 버튼 이벤트 리스너 등록');
    clearAllPublishersBtn.addEventListener('click', (e) => {
      e.preventDefault();
      clearAllPublishers();
    });
  }
});

// 저널 이름으로 출판사 찾기
function findPublisherByJournal(journalName) {
  if (!journalName || !publishersData || !publishersData.publishers) {
    return null;
  }
  
  // 저널 이름으로 출판사 찾기
  for (const publisher of publishersData.publishers) {
    if (publisher.journals) {
      const foundJournal = publisher.journals.find(j => 
        journalName.toLowerCase().includes(j.name.toLowerCase()) ||
        j.name.toLowerCase().includes(journalName.toLowerCase())
      );
      if (foundJournal) {
        return publisher;
      }
    }
  }
  
  return null;
}

// EOF: end of file

