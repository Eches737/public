// 전역 변수들
let pendingPdfParentId = null;

// NOTE: Removed aggressive modal-forcing at script load time. That logic
// hid the <dialog> element (hidden/display:none) which prevented
// showModal() from making the dialog visible in headless environments
// (Playwright/Chromium). We now ensure showPublisherModal explicitly
// clears hidden/display before calling showModal().

let state = {
    q: '',
    sort: 'relevance',
    page: 1,
    pageSize: 20,
    total: 0,
    items: [],
    selectedPublishers: new Set(),
    selectedListId: null,
    userLists: []
  };

  // DOM 요소들
  const els = {
    resultsSection: document.getElementById('resultsSection'),
    resultsList: document.getElementById('resultsList'),
    resultsMeta: document.getElementById('resultsMeta'),
    pagination: document.getElementById('pagination'),
    empty: document.getElementById('empty'),
    publisherSearchBtn: document.getElementById('publisherSearchBtn'),
    publisherDialog: document.getElementById('publisherDialog'),
    publisherList: document.getElementById('publisherList'),
    selectAllPublishers: document.getElementById('selectAllPublishers'),
    clearAllPublishers: document.getElementById('clearAllPublishers'),
    applyPublisherSelection: document.getElementById('applyPublisherSelection'),
    sidebar: document.getElementById('sidebar'),
    userLists: document.getElementById('userLists'),
    addListBtn: document.getElementById('addListBtn'),
    newListName: document.getElementById('newListName'),
    sidebarToggle: document.getElementById('sidebarToggle'),
    uploadPdf: document.getElementById('uploadPdf'),
    // 검색 폼 관련 요소들 (헤더에 위치)
    searchForm: document.getElementById('searchForm'),
    q: document.getElementById('q'),
    sort: document.getElementById('sort'),
    // 선택된 출판사 로고 표시 요소
    selectedPublisherLogos: document.getElementById('selectedPublisherLogos')
  };
  // unique id for this window/tab to avoid processing our own BroadcastChannel messages
  const WINDOW_ID = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : ('win-' + Math.random().toString(36).slice(2));
  // API 키 관리 요소
  els.manageApiKeysBtn = document.getElementById('manageApiKeysBtn');
  els.apiKeyDialog = document.getElementById('apiKeyDialog');
  els.apiKeyList = document.getElementById('apiKeyList');
  // proxy toggle & status (in header + modal)
  els.useProxyToggle = document.getElementById('useProxyToggle');
  els.proxyStatus = document.getElementById('proxyStatus');

  // DOM 요소 확인 및 디버깅
  function checkDOMElements() {
    console.log('📋 DOM 요소 확인:');
    for (const [key, element] of Object.entries(els)) {
      if (!element) {
        console.warn(`⚠️  요소 없음: ${key}`);
      } else {
        console.log(`✅ 요소 발견: ${key}`);
      }
    }
  }

  // 유틸리티 함수들
  function showToast(message, type = 'info', actionLabel = null, actionCallback = null) {
    const toast = document.createElement('div');
    toast.className = `ps-toast ps-toast--${type}`;
    toast.innerHTML = `
      <div class="ps-toast__content">${message}</div>
      <div class="ps-toast__actions"></div>
      <button class="ps-toast__close">✕</button>
    `;
    document.body.appendChild(toast);
    
    const closeBtn = toast.querySelector('.ps-toast__close');
    closeBtn.addEventListener('click', () => toast.remove());
    
    // action button (optional)
    if (actionLabel && typeof actionCallback === 'function') {
      const actionEl = document.createElement('button');
      actionEl.className = 'ps-toast__action';
      actionEl.textContent = actionLabel;
      actionEl.addEventListener('click', (e) => {
        try {
          actionCallback(e);
        } catch (err) {
          console.error('toast action callback error', err);
        }
        // close toast after action
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      });
      const actionsContainer = toast.querySelector('.ps-toast__actions');
      if (actionsContainer) actionsContainer.appendChild(actionEl);
    }
    
    setTimeout(() => {
      if (toast.parentNode) toast.remove();
    }, 5000);
  }

  // API 키 관리 UI 렌더러
  window.renderApiKeyList = function() {
    if (!els.apiKeyList || !publishersData) return;
    els.apiKeyList.innerHTML = '';
    const pubs = (publishersData.publishers || []).filter(p => p.apiUrl);
    if (pubs.length === 0) {
      els.apiKeyList.innerHTML = '<div>API 키를 등록할 수 있는 출판사가 없습니다.</div>';
      return;
    }

    for (const p of pubs) {
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.gap = '8px';

      const label = document.createElement('div');
      label.textContent = p.shortName || p.name || p.id;
      label.style.minWidth = '120px';

      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'API 키를 입력하세요';
      input.value = localStorage.getItem(`apiKey_${p.id}`) || '';
      input.style.flex = '1';
      input.style.padding = '6px';
      input.style.border = '1px solid #e2e8f0';
      input.style.borderRadius = '6px';

      const saveBtn = document.createElement('button');
      saveBtn.className = 'btn btn--primary btn--small';
      saveBtn.textContent = '저장';
      saveBtn.addEventListener('click', (e) => {
        e.preventDefault();
        try {
          const val = (input.value || '').trim();
          if (val) {
            localStorage.setItem(`apiKey_${p.id}`, val);
            showToast(`${p.shortName || p.name} API 키가 저장되었습니다.`, 'info');
          } else {
            localStorage.removeItem(`apiKey_${p.id}`);
            showToast(`${p.shortName || p.name} API 키가 제거되었습니다.`, 'info');
          }
        } catch (err) {
          console.error('API 키 저장 실패:', err);
          showToast('API 키 저장에 실패했습니다.', 'error');
        }
      });

      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn btn--ghost btn--small';
      removeBtn.textContent = '삭제';
      removeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        try {
          localStorage.removeItem(`apiKey_${p.id}`);
          input.value = '';
          showToast(`${p.shortName || p.name} API 키가 삭제되었습니다.`, 'info');
        } catch (err) {
          console.error('API 키 삭제 실패:', err);
          showToast('API 키 삭제에 실패했습니다.', 'error');
        }
      });

      row.appendChild(label);
      row.appendChild(input);
      row.appendChild(saveBtn);
      row.appendChild(removeBtn);
      els.apiKeyList.appendChild(row);
    }
  };

  window.showApiKeyModal = async function() {
    try {
      await loadPublishersData();
      renderApiKeyList();
      if (els.apiKeyDialog) {
        try { els.apiKeyDialog.hidden = false; els.apiKeyDialog.style.display = ''; } catch (e){}
        els.apiKeyDialog.showModal();
        // attach close handlers
        setTimeout(() => {
          const closeBtns = els.apiKeyDialog.querySelectorAll('.publisher-dialog__close, #closeApiKeyDialog');
          closeBtns.forEach(btn => {
            btn.addEventListener('click', (ev) => { ev.preventDefault(); window.hideApiKeyModal(); });
          });
        }, 50);
      }
    } catch (e) {
      console.error('API 키 모달 열기 실패:', e);
      showToast('API 키 관리자 열기에 실패했습니다.', 'error');
    }
  };

  window.hideApiKeyModal = function() {
    if (!els.apiKeyDialog) return;
    try { if (els.apiKeyDialog.open) els.apiKeyDialog.close(); } catch(e){}
    try { els.apiKeyDialog.hidden = true; els.apiKeyDialog.style.display = 'none'; } catch(e){}
  };

  function normalizeItem(item) {
    return {
      id: item.id || crypto.randomUUID(),
      title: item.title || '제목 없음',
      authors: item.authors || '저자 미상',
      journal: item.journal || '',
      year: item.year || '',
      doi: item.doi || '',
      url: item.url || '',
      abstract: item.abstract || '',
      keywords: item.keywords || []
    };
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // URL 파라미터 파싱
  function parseUrlParams() {
    const urlParams = new URLSearchParams(window.location.search);
    state.q = urlParams.get('q') || '';
    state.sort = urlParams.get('sort') || 'relevance';
    state.page = parseInt(urlParams.get('page')) || 1;
    // pageSize param support (default 20)
    state.pageSize = parseInt(urlParams.get('pageSize')) || 20;
    
    // 선택된 출판사 파라미터 파싱
    const publisherParam = urlParams.get('publishers');
    if (publisherParam && publisherParam.trim()) {
      state.selectedPublishers = new Set(publisherParam.split(',').filter(p => p.trim()));
      console.log('📚 URL에서 선택된 출판사:', Array.from(state.selectedPublishers));
    } else {
      // URL에 출판사 파라미터가 없으면 localStorage에서 불러온다 (새로고침 없이 유지)
      const ls = localStorage.getItem('selectedPublishers');
      if (ls) {
        try {
          const arr = JSON.parse(ls);
          if (Array.isArray(arr) && arr.length > 0) {
            state.selectedPublishers = new Set(arr);
            console.log('📚 localStorage에서 불러온 선택된 출판사:', arr);
          } else {
            state.selectedPublishers = new Set();
          }
        } catch (e) {
          state.selectedPublishers = new Set();
        }
      } else {
        state.selectedPublishers = new Set();
        console.log('📚 출판사 선택 없음 - 전체 출판사에서 검색');
      }
    }
    
    // 선택된 출판사 로고 업데이트
    updateSelectedPublisherLogos();
    
    // 검색어 표시
    console.log('📄 검색 결과 페이지 파라미터:', state);
  }

  // 검색 결과 렌더링
  function renderResults() {
    console.log('🎨 검색 결과 렌더링:', state.items?.length || 0);
    
    // 검색 완료 시 로딩 숨김 (안전장치)
    hideLoading();
    
    if (!state.items || state.items.length === 0) {
      if (els.resultsSection) els.resultsSection.hidden = true;
      if (els.empty) els.empty.hidden = false;
      return;
    }

    if (els.resultsSection) els.resultsSection.hidden = false;
    if (els.empty) els.empty.hidden = true;
    if (els.resultsList) els.resultsList.innerHTML = '';

    const template = document.getElementById('resultItemTemplate');
    if (!template) return;

    for (const item of state.items) {
      const cloned = template.content.cloneNode(true);
      const li = cloned.querySelector('li');
      
      // 데이터 설정
      li.dataset.id = item.id;
      // 검색 결과임을 표시
      li.classList.add('search-result');
      
      // 필드 채우기
      li.querySelectorAll('[data-field]').forEach(el => {
        const field = el.getAttribute('data-field');
        const value = item[field] || '';
        
        if (field === 'url') {
          const titleEl = li.querySelector('.result-card__link');
          if (titleEl) {
            titleEl.textContent = item.title || '';
            // 실제 논문 URL을 사용하되, 검색 엔진 링크도 제공
            // titleEl.href = item.url || item.searchUrl || '#';
            // titleEl.target = '_blank';
            // 출판사 정보 표시
            titleEl.setAttribute('data-publisher', item.publisher?.id || '');
          }
        } else if (field === 'keywords') {
          // 키워드 배열을 개별 span으로 렌더링
          if (Array.isArray(item.keywords) && item.keywords.length > 0) {
            el.innerHTML = item.keywords
              .map(keyword => `<span>${keyword}</span>`)
              .join('');
          } else {
            el.style.display = 'none';
          }
        } else if (field !== 'title' && field !== 'url') {
          el.textContent = value;
        }
      });
      
      // 출판사 아이콘 추가
      const titleEl = li.querySelector('.result-card__link');
      if (titleEl && item.publisher) {
        const iconSpan = document.createElement('span');
        iconSpan.className = 'publisher-icon';
        iconSpan.textContent = item.publisher.logo || '📚';
        iconSpan.style.marginRight = '8px';
        titleEl.insertBefore(iconSpan, titleEl.firstChild);
      }
      
      // 저널 정보에 출판사 로고 포함
      const journalEl = li.querySelector('[data-field="journal"]');
      if (journalEl) {
        // 출판사 이름 표시
        journalEl.textContent = item.publisher?.name || item.journal || '';
        
        // 출판사 ID 추가 (클릭 시 필터링용)
        if (item.publisher?.id) {
          journalEl.setAttribute('data-publisher-id', item.publisher.id);
          journalEl.style.cursor = 'pointer';
          journalEl.style.textDecoration = 'underline';
          journalEl.title = `${item.publisher.name} 검색 결과로 필터링`;
        }
        
        // 출판사 로고 추가 (있는 경우)
        if (item.publisher && item.publisher.id !== 'mock' && item.publisher.logo) {
          const journalBlock = document.createElement('span');
          journalBlock.className = 'journal-with-publisher';

          // 출판사 로고 추가
          const logoSpan = document.createElement('span');
          logoSpan.className = 'publisher-logo-inline';
          logoSpan.textContent = item.publisher.logo;
          logoSpan.style.marginRight = '4px';

          // 출판사 이름 추가
          const publisherText = document.createTextNode(item.publisher.name || '');

          journalBlock.appendChild(logoSpan);
          journalBlock.appendChild(publisherText);

          journalEl.innerHTML = '';
          journalEl.appendChild(journalBlock);
          
          // 블록 전체에 클릭 이벤트 적용
          journalBlock.setAttribute('data-publisher-id', item.publisher.id);
          journalBlock.style.cursor = 'pointer';
          journalBlock.title = `${item.publisher.name} 검색 결과로 필터링`;
        }
      }
      
      // DOI 버튼 텍스트에 DOI 주소 표시
      const doiBtn = li.querySelector('[data-action="copy-doi"]');
      if (doiBtn && item.doi) {
        doiBtn.textContent = 'DOI 복사';
        // 추가: DOI 링크 버튼을 만들어 원문으로 바로 이동 가능하게 함
        const doiLink = document.createElement('a');
        doiLink.className = 'btn btn--ghost btn--sm';
        doiLink.textContent = 'DOI 열기';
        doiLink.href = `https://doi.org/${encodeURIComponent(item.doi)}`;
        doiLink.target = '_blank';
        doiLink.rel = 'noopener';
        doiLink.style.marginLeft = '6px';
        doiLink.setAttribute('data-action', 'open-doi');
        // insert after the copy button
        doiBtn.insertAdjacentElement('afterend', doiLink);
      } else if (doiBtn) {
        doiBtn.textContent = 'DOI 복사';
      }

      // If the result has a direct PDF URL, add a quick "PDF 열기" button
      // Always add a PDF/Open button; we'll probe the URL via the local server to detect PDF content-type
      try {
        const actionsPrimary = li.querySelector('.result-card__actions-primary');
        if (actionsPrimary) {
          // '원문 열기' 버튼 removed per request; keep other action buttons unchanged.
        }
      } catch (e) {
        console.warn('PDF 버튼 추가 중 오류:', e);
      }
      
      els.resultsList.appendChild(li);
    }

    // 메타 정보 업데이트
    if (els.resultsMeta) {
      const publisherCount = new Set(state.items.map(item => item.publisher?.id)).size;
      els.resultsMeta.textContent = state.total ? 
        `총 ${state.total}개 논문 (${publisherCount}개 출판사에서)` : '';
    }
    // 페이지네이션 렌더
    try {
      renderPagination();
    } catch (e) {
      console.warn('페이지네이션 렌더 중 오류:', e);
      if (els.pagination) els.pagination.innerHTML = '';
    }
  }

  // 페이지네이션 렌더링
  function renderPagination() {
    if (!els.pagination || !state.total) return;
    const pageSize = state.pageSize || 20;
    const totalPages = Math.ceil(state.total / pageSize);
    
    if (totalPages <= 1) {
      els.pagination.innerHTML = '';
      return;
    }

    let html = '<div class="pagination__list">';
    
    // 이전 페이지
    if (state.page > 1) {
      html += `<button class="pagination__btn" data-page="${state.page - 1}">이전</button>`;
    }
    
    // 페이지 번호들
  // show a sliding window of page numbers around the current page
  const RANGE = 2;
  const start = Math.max(1, state.page - RANGE);
  const end = Math.min(totalPages, state.page + RANGE);
    
    for (let i = start; i <= end; i++) {
      const active = i === state.page ? ' pagination__btn--active' : '';
      html += `<button class="pagination__btn${active}" data-page="${i}">${i}</button>`;
    }
    
    // 다음 페이지
    if (state.page < totalPages) {
      html += `<button class="pagination__btn" data-page="${state.page + 1}">다음</button>`;
    }
    
    html += '</div>';
    els.pagination.innerHTML = html;
  }

  // 검색 실행
  // 출판사 데이터 캐시
  let publishersData = null;
  
  // 출판사별 API 매핑 - 검색 사이트 API 제거, 출판사 직접 API만 유지
  const publisherApiMappings = {
    // Nature 그룹 - 출판사 직접 API 사용
    'nature': {
      apis: [],
      filters: { venue: ['Nature', 'Nature Biotechnology', 'Nature Medicine', 'Nature Materials'] }
    },

    // Science/AAAS - 출판사 직접 API 사용
    'science': {
      apis: [],
      filters: { venue: ['Science', 'Science Translational Medicine', 'Science Advances'] }
    },

    'aaas': {
      apis: [],
      filters: { venue: ['Science'] }
    },

    // Elsevier - 출판사 직접 API 사용
    'elsevier': {
      apis: [],
      filters: { venue: ['Cell', 'The Lancet', 'Energy & Environmental Science', 'Journal of the American Chemical Society'] }
    },

    // Springer - 출판사 직접 API 사용
    'springer': {
      apis: [],
      filters: { venue: ['Journal of Materials Science', 'Applied Physics Letters', 'European Journal of Operational Research'] }
    },

    // Wiley - 출판사 직접 API 사용
    'wiley': {
      apis: [],
      filters: { venue: ['Advanced Materials', 'Angewandte Chemie', 'Small'] }
    },

    // ACS - 출판사 직접 API 사용
    'acs': {
      apis: [],
      filters: { venue: ['Journal of the American Chemical Society', 'ACS Nano', 'Chemical Reviews'] }
    },

    // IEEE - 출판사 직접 API 사용
    'ieee': {
      apis: [],
      filters: { venue: ['Proceedings of the IEEE', 'IEEE Transactions on Pattern Analysis and Machine Intelligence', 'IEEE Internet of Things Journal'] }
    },

    // PLOS - 출판사 직접 API 사용
    'plos': {
      apis: [],
      filters: { venue: ['PLOS ONE', 'PLOS Biology', 'PLOS Medicine'] }
    },

    // RSC - 출판사 직접 API 사용
    'rsc': {
      apis: [],
      filters: { venue: ['Chemical Science', 'Energy & Environmental Science'] }
    }
  };

  // 출판사 데이터 로드
  async function loadPublishersData() {
    if (!publishersData) {
      // 우선 서버 엔드포인트(/api/publishers)를 시도하고, 실패하면 정적 파일(publishers.json)을 폴백합니다.
      try {
        console.log('📚 출판사 데이터 로드 시도: /api/publishers');
        const apiPath = `${window.location.protocol}//${window.location.hostname}:3001/api/publishers`;
        let response = null;
        try {
          response = await fetch(apiPath);
          if (response && response.ok) {
            publishersData = await response.json();
            console.log('📚 출판사 데이터 로드 완료 (서버):', publishersData?.publishers?.length || 0, '개 출판사');
          } else {
            console.warn('📚 /api/publishers 응답이 없거나 오류임, 상태:', response && response.status);
            response = null;
          }
        } catch (e) {
          console.warn('📚 /api/publishers 호출 실패:', e);
          response = null;
        }

        if (!publishersData) {
          // 서버에서 못가져오면 정적 파일을 시도
          console.log('📚 폴백: publishers.json 로드 시도');
          const staticResp = await fetch('publishers.json');
          if (!staticResp.ok) throw new Error(`HTTP error! status: ${staticResp.status}`);
          publishersData = await staticResp.json();
          console.log('📚 출판사 데이터 로드 완료 (정적 파일):', publishersData?.publishers?.length || 0, '개 출판사');
        }

        if (!publishersData.publishers || publishersData.publishers.length === 0) {
          console.warn('출판사 데이터가 비어있습니다');
        }
      } catch (error) {
        console.error('출판사 데이터 로드 실패:', error);
        publishersData = { publishers: [] };
        showToast('출판사 데이터를 불러오는데 실패했습니다.', 'error');
      }
    }

    // 서버(프록시)가 지원하는 출판사 목록을 가져와서 클라이언트에서 사용
    try {
      const apiBase = `${window.location.protocol}//${window.location.hostname}:3001`;
      const capResp = await fetch(`${apiBase}/api/publishers`);
      if (capResp && capResp.ok) {
        const capJson = await capResp.json();
        const arr = Array.isArray(capJson.supportedPublishers) ? capJson.supportedPublishers : [];
        // 전역으로 저장하여 callPublisherApi에서 참조
        window.proxySupportedPublishers = new Set(arr);
        console.log('📡 서버 프록시가 지원하는 출판사:', arr);
      } else {
        window.proxySupportedPublishers = new Set();
        console.log('📡 /api/publishers 응답 없음 또는 오류:', capResp && capResp.status);
      }
    } catch (e) {
      console.warn('📡 /api/publishers 호출 실패:', e);
      window.proxySupportedPublishers = new Set();
    }
    return publishersData;
  }

  // 특정 출판사 API 호출: 가능한 경우 출판사 제공 API를 직접 사용
  // - pid: publisher id
  // - q: 검색어
  // - page, pageSize: 페이징
  // 반환값은 중앙 백엔드와 유사한 { items: [...], total: N } 형태
  async function callPublisherApi(pid, q, page = 1, pageSize = 20) {
    const pub = (publishersData.publishers || []).find(p => p.id === pid);
    if (!pub || !pub.apiUrl) throw new Error('출판사 API 없음');

    // 기본 파라미터
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    params.set('page', page || 1);
    params.set('pageSize', pageSize || 20);

    // API 키가 로컬스토리지에 저장되어 있을 수 있음: key 형식 apiKey_<publisherId>
    const apiKey = localStorage.getItem(`apiKey_${pid}`) || localStorage.getItem('apiKey') || null;

    // 빌드 요청 URL
    let url = pub.apiUrl;
    // 일부 API는 path에 쿼리 없이 동작; append '?' accordingly
    url += (url.includes('?') ? '&' : '?') + params.toString();

    const headers = {};
    if (apiKey) {
      // 여러 API의 관행을 최대한 포괄: Authorization Bearer, X-API-Key, api_key param
      headers['Authorization'] = `Bearer ${apiKey}`;
      headers['X-API-Key'] = apiKey;
      // also append api_key param as fallback
      url += `&api_key=${encodeURIComponent(apiKey)}`;
    }

    console.log('📡 callPublisherApi:', pid, url);

    // Try local proxy only if user enabled proxy usage
    const localProxy = `${window.location.protocol}//${window.location.hostname}:3001/api/search/${encodeURIComponent(pid)}?${params.toString()}`;
    try {
      // Only attempt proxy if user enabled it and server reports support for this publisher
      const proxyEnabled = window.usePublisherProxy === true;
      const proxySupports = window.proxySupportedPublishers && window.proxySupportedPublishers.has && window.proxySupportedPublishers.has(pid);
      if (proxyEnabled && proxySupports) {
        console.log('📡 try local proxy for publisher API:', localProxy);
        const pResp = await fetch(localProxy);
        if (pResp) {
          if (pResp.ok) {
            const pJson = await pResp.json();
            // normalize similar to central shape
            const itemsRaw = pJson.items || pJson.records || pJson.results || [];
            const items = (itemsRaw || []).map(it => {
              const title = it.title || it.article_title || it.document_title || '';
              const journal = it.journal || it.publication || it.source || '';
              const authors = it.authors || it.author || (Array.isArray(it.authors) ? it.authors.join(', ') : '');
              const doi = it.doi || it.DOI || '';
              const year = it.year || it.pub_year || it.publication_year || '';
              const url = it.url || it.link || '';
              const abstract = it.abstract || it.description || '';
              const keywords = it.keywords || it.subjects || [];
              return { id: it.id || it.key || crypto.randomUUID(), title, authors, journal, year, doi, url, abstract, keywords };
            });
            const total = pJson.total || items.length;
            return { items, total };
          } else {
            // Proxy returned non-OK (400/500 etc.)
            console.warn('📡 local proxy responded with error status:', pResp.status, pResp.statusText);
            // Try to parse JSON error body to detect unsupported publisher case
            let body = null;
            try { body = await pResp.json(); } catch (e) { /* ignore parse errors */ }
            const errMsg = body && body.error ? String(body.error) : '';
            if (pResp.status === 400 && /Unsupported publisher/i.test(errMsg)) {
              // Server explicitly doesn't support this publisher — skip showing user-level proxy guidance
              console.log('📡 proxy reports unsupported publisher, skipping proxy path for', pid);
              // fallthrough to direct publisher call (or central backend fallback)
            } else if (pResp.status === 400) {
              showToast('프록시 서버가 요청을 처리하지 못했습니다 (400). 서버 로그를 확인하거나 프록시를 비활성화하세요.', 'error', '프록시 끄기', () => {
                try {
                  localStorage.setItem('useProxy', 'false');
                  window.usePublisherProxy = false;
                  if (els.useProxyToggle) els.useProxyToggle.checked = false;
                  updateProxyStatusUI();
                  // 재검색 요청
                  search();
                } catch (err) {
                  console.error('프록시 끄기 처리 중 오류:', err);
                }
              });
            } else {
              showToast(`프록시 서버 오류: ${pResp.status} ${pResp.statusText}`, 'error', '프록시 끄기', () => {
                try {
                  localStorage.setItem('useProxy', 'false');
                  window.usePublisherProxy = false;
                  if (els.useProxyToggle) els.useProxyToggle.checked = false;
                  updateProxyStatusUI();
                  search();
                } catch (err) {
                  console.error('프록시 끄기 처리 중 오류:', err);
                }
              });
            }
            // fallthrough to try direct call (or let caller fallback to central)
          }
        }
      } else {
        console.log('📡 로컬 프록시 사용이 비활성화되어 있어 프록시 요청을 건너뜁니다');
      }
    } catch (e) {
      console.warn('📡 local proxy call failed or not available, falling back to publisher API:', e);
    }

    // Fallback: call publisher API directly from the browser. This may fail due to CORS.
    try {
      const resp = await fetch(url, { headers });
      if (resp && !resp.ok) {
        console.warn('📡 publisher direct responded with status:', resp.status, resp.statusText);
        if (resp.status === 401) {
          // 인증 실패 - 사용자에게 API 키 입력을 유도
          showToast('출판사 API 인증 실패(401). API 키를 설정하면 직접 호출이 가능합니다.', 'error', 'API 키 설정', () => {
            const key = prompt('해당 출판사(API)용 API 키를 입력하세요:');
            if (key && key.trim()) {
              try {
                localStorage.setItem(`apiKey_${pid}`, key.trim());
                showToast('API 키가 저장되었습니다. 다시 시도합니다...', 'info');
                // 재시도: 전체 검색을 트리거하면 callPublisherApi가 다시 실행됨
                search();
              } catch (e) {
                console.error('API 키 저장 중 오류:', e);
                showToast('API 키 저장에 실패했습니다.', 'error');
              }
            }
          });
        } else if (resp.status >= 400 && resp.status < 500) {
          showToast(`출판사 API 요청 오류: ${resp.status} ${resp.statusText}`, 'error');
        } else {
          showToast(`출판사 API 서버 오류: ${resp.status} ${resp.statusText}`, 'error');
        }
        throw new Error(`출판사 API 호출 실패: ${resp.status} ${resp.statusText}`);
      }
      const json = await resp.json();

      // 가능한 items/records 위치를 찾아 정규화
      let itemsRaw = json.items || json.records || json.response?.docs || json.results || json.documents || json.data?.records || json.data?.response?.docs || [];
      // 일부 API는 결과 자체가 배열일 수 있음
      if (!Array.isArray(itemsRaw) && Array.isArray(json)) itemsRaw = json;

      // normalize to central shape
      const items = itemsRaw.map(it => {
        const title = it.title || it.article_title || (it.title_display && it.title_display[0]) || '';
        const journal = it.journal || it.publication || it.source || it.journal_title || '';
        const authors = it.author || it.authors || (it.author_display && it.author_display.join(', ')) || '';
        const doi = it.doi || it.DOI || (it.identifiers && it.identifiers.doi) || '';
        const year = it.pub_year || it.publication_year || it.year || '';
        const url = it.url || it.link || (it.fulltext_url && it.fulltext_url[0]) || '';
        const abstract = it.abstract || it.description || it.summary || '';
        const keywords = it.keywords || it.subjects || it.tags || [];

        return { id: it.id || it.key || crypto.randomUUID(), title, authors, journal, year, doi, url, abstract, keywords };
      });

      // best-effort total
      const total = json.total || json.response?.numFound || json.meta?.total || items.length;
      return { items, total };
    } catch (err) {
      console.error('📡 출판사 직접 호출 실패:', err);
      // 안내: CORS 등 네트워크 오류가 발생하면 사용자에게 프록시 활성화를 제안
      const isNetworkError = /Failed to fetch|NetworkError|Network request failed/i.test(err.message || '');
      if (isNetworkError) {
        showToast('직접 출판사 API 호출이 브라우저에서 차단되었습니다. 프록시 사용을 권장합니다.', 'error', '프록시 사용', () => {
          try {
            localStorage.setItem('useProxy', 'true');
            window.usePublisherProxy = true;
            if (els.useProxyToggle) els.useProxyToggle.checked = true;
            updateProxyStatusUI();
            // 재시도: 사용자 의도에 따라 즉시 재검색을 트리거
            search();
          } catch (e) {
            console.error('프록시 활성화 처리 중 오류:', e);
          }
        });
      }
      throw err;
    }

    // 가능한 items/records 위치를 찾아 정규화
    let itemsRaw = json.items || json.records || json.response?.docs || json.results || json.documents || json.data?.records || json.data?.response?.docs || [];
    // 일부 API는 결과 자체가 배열일 수 있음
    if (!Array.isArray(itemsRaw) && Array.isArray(json)) itemsRaw = json;

    // normalize to central shape
    const items = itemsRaw.map(it => {
      const title = it.title || it.article_title || (it.title_display && it.title_display[0]) || '';
      const journal = it.journal || it.publication || it.source || it.journal_title || '';
      const authors = it.author || it.authors || (it.author_display && it.author_display.join(', ')) || '';
      const doi = it.doi || it.DOI || (it.identifiers && it.identifiers.doi) || '';
      const year = it.pub_year || it.publication_year || it.year || '';
      const url = it.url || it.link || (it.fulltext_url && it.fulltext_url[0]) || '';
      const abstract = it.abstract || it.description || it.summary || '';
      const keywords = it.keywords || it.subjects || it.tags || [];

      return { id: it.id || it.key || crypto.randomUUID(), title, authors, journal, year, doi, url, abstract, keywords };
    });

    // best-effort total
    const total = json.total || json.response?.numFound || json.meta?.total || items.length;
    return { items, total };
  }

async function search() {
  try {
    console.log('🔍 검색 실행:', state);
    
    // 로딩 표시
    showLoading();
    
  // 출판사 데이터 로드
  await loadPublishersData();
    
    // 검색어 확인: 빈 검색어면 결과를 비우고 종료
    if (!state.q || !state.q.trim()) {
      console.log('🔍 검색어 없음 - 빈 결과 표시');
      state.items = [];
      state.total = 0;
      renderResults();
      return;
    }

    // 실제 API 사용: 우선, 단일 출판사가 선택되었고 해당 출판사의 API가 제공되면
    // 직접 출판사 API를 호출하도록 시도한다. 그렇지 않으면 중앙 백엔드로 요청.
    const selectedPublisherIds = Array.from(state.selectedPublishers || []);

    let data = null;

    if (selectedPublisherIds.length === 1) {
      const pid = selectedPublisherIds[0];
      const pub = (publishersData.publishers || []).find(p => p.id === pid);
      if (pub && pub.apiUrl) {
        try {
          console.log(`🌐 단일 출판사 선택; ${pid} API 호출 시도:`, pub.apiUrl);
          data = await callPublisherApi(pid, state.q, state.page, state.pageSize || 20);
        } catch (err) {
          console.warn('📡 출판사 API 호출 실패, 중앙 백엔드로 폴백:', err);
          data = null;
        }
      }
    }

    if (!data) {
      // 중앙 백엔드로 요청
      console.log('🌐 중앙 백엔드 API 모드로 검색 실행');
      const params = new URLSearchParams();
      if (state.q) params.set('q', state.q);
      if (state.sort && state.sort !== 'relevance') params.set('sort', state.sort);
      if (state.page && state.page !== 1) params.set('page', state.page);
      if (state.pageSize) params.set('pageSize', state.pageSize);
      // source 결정 (예: arxiv/crossref)
      let source = 'all';
      if (state.selectedPublishers && state.selectedPublishers.size > 0) {
        const selected = Array.from(state.selectedPublishers);
        if (selected.includes('arxiv')) source = 'arxiv';
        else if (selected.includes('crossref')) source = 'crossref';
      }
      params.set('source', source);
      if (state.selectedPublishers && state.selectedPublishers.size > 0) {
        params.set('publishers', Array.from(state.selectedPublishers).join(','));
      }
      const apiUrl = `http://localhost:3001/api/search?${params.toString()}`;
      console.log('🌐 백엔드 API 호출:', apiUrl);
      const response = await fetch(apiUrl);
      if (!response.ok) throw new Error(`API 호출 실패: ${response.status} ${response.statusText}`);
      data = await response.json();
      console.log('✅ 중앙 백엔드 응답 수신:', { total: data.total, itemsCount: data.items?.length || 0 });
    }

    // data가 출판사 API 형식이거나 중앙 백엔드 형식일 수 있으므로, 일관된 형태로 정규화
    const itemsRaw = data.items || data.records || data.response?.docs || data.results || data.documents || [];
    const itemsWithPublishers = itemsRaw.map(item => {
      // 유연한 필드 추출
      const title = item.title || item.article_title || item.document_title || (item.title_display && item.title_display[0]) || '';
      const journal = item.journal || item.publication || item.source || item.journal_title || '';
      const authors = item.authors || item.author || item.author_display || (Array.isArray(item.authors) ? item.authors.join(', ') : '');
      const doi = item.doi || item.DOI || (item.identifiers && item.identifiers.doi) || '';
      const year = item.year || item.pub_year || item.publication_year || '';
      const url = item.url || item.link || item.fulltext_url || '';
      const abstract = item.abstract || item.description || item.summary || '';
      const keywords = item.keywords || item.subjects || item.tags || [];

      const publisher = findPublisherByJournal(journal);

      return {
        id: item.id || item.key || crypto.randomUUID(),
        title,
        authors,
        journal,
        year,
        doi,
        url,
        abstract,
        keywords,
        publisher: publisher ? { id: publisher.id, name: publisher.shortName || publisher.name, logo: publisher.logo, color: publisher.color } : { id: 'unknown', name: journal }
      };
    });

    // 클라이언트 측 안전 필터: 선택된 출판사가 있으면 필터링
    if (state.selectedPublishers && state.selectedPublishers.size > 0) {
      const sel = new Set(state.selectedPublishers);
      const filtered = itemsWithPublishers.filter(it => it.publisher && sel.has(it.publisher.id));
      state.items = filtered;
      state.total = filtered.length;
    } else {
      state.items = itemsWithPublishers;
      state.total = data.total || itemsWithPublishers.length || 0;
    }

    renderResults();
  } catch (error) {
    console.error('검색 실패:', error);
    showToast('검색 중 오류가 발생했습니다.', 'error');
    // 에러 발생 시에도 로딩 숨김
    hideLoading();
  } finally {
    // 검색 완료 후 로딩 숨김 (안전장치)
    hideLoading();
  }
}

// 로딩 표시/숨김 함수
function showLoading() {
  console.log('🔄 showLoading() 함수 호출됨');
  const loadingIndicator = document.getElementById('loadingIndicator');
  console.log('🔄 loadingIndicator 요소:', loadingIndicator);
  if (loadingIndicator) {
    loadingIndicator.hidden = false;
    loadingIndicator.style.display = 'flex'; // 명시적으로 표시
    console.log('🔄 로딩 표시: hidden = false, display = flex');
  } else {
    console.error('❌ loadingIndicator 요소를 찾을 수 없음');
  }
}

function hideLoading() {
  console.log('✅ hideLoading() 함수 호출됨');
  const loadingIndicator = document.getElementById('loadingIndicator');
  console.log('✅ loadingIndicator 요소:', loadingIndicator);
  if (loadingIndicator) {
    loadingIndicator.hidden = true;
    loadingIndicator.style.display = 'none'; // 명시적으로 숨김
    console.log('✅ 로딩 숨김: hidden = true, display = none');
  } else {
    console.error('❌ loadingIndicator 요소를 찾을 수 없음');
  }
}

// 사이드바 렌더링
function renderSidebar() {
  if (!els.userLists) return;
  
  console.log('🔍 사이드바 렌더링:', state.userLists?.length || 0);
  
  // ListCore 상태 사용
  if (window.ListCore && window.ListCore.state && window.ListCore.state.lists) {
    state.userLists = window.ListCore.state.lists;
  }
  
  const ul = els.userLists;
  ul.innerHTML = "";
  
  const buildList = (lists, container) => {
    for (const list of lists) {
      const li = document.createElement('li');
      li.className = 'user-list-item';
      if (list.type === 'pdf') li.classList.add('user-list-item--pdf');
      li.dataset.id = list.id;
      li.draggable = true;
      
      if (state.selectedListId === list.id) li.setAttribute('aria-current', 'true');
      
      const actions = document.createElement('div');
      actions.className = 'user-list__actions';
      
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
      
      const header = document.createElement('div');
      header.className = 'user-list-item__header';
      const selectedClass = state.selectedListId === list.id ? ' user-list-item__title--selected' : '';
      header.innerHTML = `<span class="user-list__title${selectedClass}">${escapeHtml(list.name)}</span>`;
      header.appendChild(actions);
      li.appendChild(header);

      // If this list item is a PDF node, make its title open the PDF viewer on click
      if (list.type === 'pdf') {
        try {
          const titleEl = header.querySelector('.user-list__title');
          if (titleEl) {
            titleEl.style.cursor = 'pointer';
            titleEl.title = 'PDF 열기';
            titleEl.addEventListener('click', (ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              // Construct an item shape compatible with openPdf
              const pdfItem = {};
              if (list.fileId) pdfItem.fileId = list.fileId;
              else if (list.remoteUrl) pdfItem.url = list.remoteUrl;
              else if (list.url) pdfItem.url = list.url;
              else if (list.name) {
                // fallback: no URL or fileId
                showToast('열 수 있는 PDF 정보가 없습니다.', 'error');
                return;
              }
              try {
                openPdf(pdfItem);
              } catch (err) {
                console.error('PDF 열기 실패:', err);
                showToast('PDF를 열 수 없습니다.', 'error');
              }
            });
          }
        } catch (err) {
          console.warn('PDF 타이틀 클릭 핸들러 등록 실패:', err);
        }
      }
      
      
      // Allow dropping search-result items onto this list
      li.addEventListener('dragover', (e) => {
        try {
          const types = e.dataTransfer && e.dataTransfer.types ? Array.from(e.dataTransfer.types) : [];
          // allow drop for our custom type or file drops
          if (types.includes('application/x-paperscout-result') || types.includes('Files')) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            li.classList.add('drag-over');
          }
        } catch (err) { /* ignore */ }
      });
      li.addEventListener('dragleave', (e) => {
        try { li.classList.remove('drag-over'); } catch (err) {}
      });

      li.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          li.classList.remove('drag-over');
          // If files were dropped, let existing file-handling run (handled elsewhere)
          const files = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length ? Array.from(e.dataTransfer.files) : [];
          if (files.length > 0) {
            // delegate to existing file drop logic by triggering click on hidden upload input
            if (els.uploadPdf) {
              // set files on upload input not straightforward; fallback to user-driven upload
              showToast('파일을 목록에 추가하려면 사이드바의 PDF 추가 버튼을 사용하세요.');
            }
            return;
          }

          const payload = e.dataTransfer.getData('application/x-paperscout-result');
          if (payload) {
            let parsed = null;
            try { parsed = JSON.parse(payload); } catch (err) { parsed = null; }
            if (parsed) {
              // Create a node compatible with ListCore
              const node = {
                id: crypto.randomUUID(),
                name: parsed.title || parsed.id || '문서',
                remoteUrl: parsed.url || null,
                type: 'pdf',
                children: []
              };
              // add to this list
              const success = await addNodeToParent(list.id, node);
              if (success) showToast('검색 결과가 목록에 추가되었습니다.');
              else showToast('목록에 추가에 실패했습니다.', 'error');
            }
          }
        } catch (err) {
          console.error('drop 처리 실패:', err);
        }
      });

      container.appendChild(li);
      
      if (list.children && list.children.length > 0) {
        const childUl = document.createElement('ul');
        childUl.className = 'user-list-item__children';
        buildList(list.children, childUl);
        li.appendChild(childUl);
      }
    }
  };
  
  buildList(state.userLists, ul);
  
  // ListCore의 드래그 앤 드롭 기능 활성화
  if (window.ListCore && typeof window.ListCore.enableDragAndDrop === 'function') {
    console.log('🔥 ListCore.enableDragAndDrop 호출:', ul);
    window.ListCore.enableDragAndDrop(ul);
    console.log('✅ ListCore.enableDragAndDrop 완료');
  } else {
    console.error('❌ ListCore.enableDragAndDrop 함수를 찾을 수 없음');
  }
}

// 전역 renderSidebar 함수로 등록 (IIFE 끝에서 실행)
function assignGlobalFunctions() {
  window.renderSidebar = renderSidebar;
}

// ListCore 초기화 및 사이드바 설정
async function initSidebar() {
    try {
      console.log('🔍 사이드바 초기화 시작');
      
      // window.state 불러오기
      await loadWindowState();
      console.log('📝 window.state 불러오기 완료:', window.state);
      
      if (window.ListCore) {
        await window.ListCore.init();
        console.log('✅ ListCore 초기화 완료');
        
        // 저장된 목록 데이터 불러오기
        await window.ListCore.loadLists();
        console.log('📚 저장된 목록 데이터 로드 완료');
        
        // 전역 window.state와 ListCore 상태 동기화
        if (!window.state) {
          window.state = { userLists: [], selectedListId: null };
        }
        window.state.userLists = window.ListCore.state.lists || [];
        state.userLists = window.state.userLists;
        state.selectedListId = window.state.selectedListId || null;
        console.log('🔍 초기화 후 selectedListId:', state.selectedListId);
        
        // ListCore 이벤트 리스너 설정
        window.ListCore.on('stateChanged', (event) => {
          console.log('📝 ListCore 상태 변경:', event);
          // 전역 상태와 로컬 상태 동기화
          window.state.userLists = window.ListCore.state.lists || [];
          state.userLists = window.state.userLists;
          // selectedListId는 유지
          renderSidebar();
        });
        
        renderSidebar();
      }
    } catch (error) {
      console.warn('사이드바 초기화 실패:', error);
    }
  }

  // 이벤트 리스너 설정
  function setupEventListeners() {
    console.log('🔧 이벤트 리스너 설정 시작');
    
    // 검색 폼 제출
    if (els.searchForm) {
      console.log('🔍 검색 폼 이벤트 리스너 등록');
      els.searchForm.addEventListener('submit', (e) => {
        e.preventDefault();
        handleSearchSubmit();
      });
    }

    // 출판사 선택 버튼
    if (els.publisherSearchBtn) {
      console.log('📚 출판사 선택 버튼 이벤트 리스너 등록');
      els.publisherSearchBtn.addEventListener('click', (e) => {
        e.preventDefault();
        console.log('📚 출판사 선택 버튼 클릭');
        showPublisherModal();
      });
    }

    // API 키 관리 버튼
    if (els.manageApiKeysBtn) {
      els.manageApiKeysBtn.addEventListener('click', (e) => {
        e.preventDefault();
        showApiKeyModal();
      });
    }

    // 프록시 사용 토글 이벤트 리스너
    if (els.useProxyToggle) {
      els.useProxyToggle.addEventListener('change', (e) => {
        const enabled = !!e.target.checked;
        try {
          localStorage.setItem('useProxy', enabled ? 'true' : 'false');
        } catch (err) {
          console.warn('useProxy localStorage 저장 실패:', err);
        }
        window.usePublisherProxy = enabled;
        updateProxyStatusUI();
        showToast(`서버 프록시 사용이 ${enabled ? '활성화' : '비활성화'}되었습니다.`, 'info');
      });
    }

    // 출판사 모달 닫기
    if (els.publisherDialog) {
      console.log('📚 출판사 모달 닫기 이벤트 리스너 등록');
      
      // ESC 키로 모달 닫기 - 전역 이벤트 리스너
      const escKeyHandler = (e) => {
        console.log('📚 키보드 이벤트:', e.key, '모달 상태:', {
          open: els.publisherDialog?.open,
          hidden: els.publisherDialog?.hidden
        });
        
        if (e.key === 'Escape' && els.publisherDialog && !els.publisherDialog.hidden && els.publisherDialog.open) {
          e.preventDefault();
          console.log('📚 ESC 키로 모달 닫기');
          window.hidePublisherModal();
        }
      };
      document.addEventListener('keydown', escKeyHandler);
      
    } else {
      console.warn('⚠️ 출판사 모달을 찾을 수 없습니다');
    }

    // 출판사 적용 버튼
    if (els.applyPublisherSelection) {
      console.log('📚 출판사 적용 버튼 이벤트 리스너 등록');
      els.applyPublisherSelection.addEventListener('click', (e) => {
        e.preventDefault();
        applyPublisherSelection();
      });
    } else {
      console.warn('⚠️ 출판사 적용 버튼을 찾을 수 없습니다');
    }

    // 모두 선택 버튼
    if (els.selectAllPublishers) {
      console.log('📚 모두 선택 버튼 이벤트 리스너 등록');
      els.selectAllPublishers.addEventListener('click', (e) => {
        e.preventDefault();
        selectAllPublishers();
      });
    }

    // 모두 해제 버튼
    if (els.clearAllPublishers) {
      console.log('📚 모두 해제 버튼 이벤트 리스너 등록');
      els.clearAllPublishers.addEventListener('click', (e) => {
        e.preventDefault();
        clearAllPublishers();
      });
    }

    // 페이지네이션 클릭
    if (els.pagination) {
      els.pagination.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-page]');
        if (!btn) return;
        
        const newPage = parseInt(btn.dataset.page);
        if (newPage !== state.page) {
          state.page = newPage;
          updateUrl();
          search();
        }
      });
    }

    // 결과 항목 클릭 (목록에 추가, DOI 복사 등)
    if (els.resultsList) {
      els.resultsList.addEventListener('click', (e) => {
        const li = e.target.closest('.result-item');
        if (!li) return;
        
        const id = li.dataset.id;
        const item = state.items.find(it => it.id === id);
        
        // 출판사 클릭 시 필터링
        if (e.target.closest('[data-publisher-id]')) {
          const publisherId = e.target.closest('[data-publisher-id]').getAttribute('data-publisher-id');
          if (publisherId) {
            state.selectedPublishers = new Set([publisherId]);
            updateUrlWithPublishers();
            search();
          }
          return;
        }
        
        if (e.target.closest('[data-action="add-to-list"]')) {
          addToList(item);
        } else if (e.target.closest('[data-action="copy-doi"]')) {
          copyDoi(item);
        } else if (e.target.closest('[data-action="view-details"]')) {
          // 상세보기: 외부 페이지로 이동
          if (item.url) {
            window.open(item.url, '_blank');
          }
        } else if (e.target.closest('[data-field="url"]')) {
          e.preventDefault(); // 기본 링크 동작 막기
          openPdf(item);
        }
      });

      // Dragstart handling for search result items -> allow dragging into sidebar lists
      els.resultsList.addEventListener('dragstart', (e) => {
        try {
          const li = e.target.closest('.result-item');
          if (!li) return;
          const id = li.dataset.id;
          const item = state.items.find(it => it.id === id);
          if (!item) return;
          // set dataTransfer payload (stringified minimal item)
          const payload = JSON.stringify({ id: item.id, title: item.title, url: item.url, doi: item.doi, authors: item.authors });
          e.dataTransfer.setData('application/x-paperscout-result', payload);
          e.dataTransfer.effectAllowed = 'copy';
          // add a drag image if available
          if (li && li.cloneNode) {
            try {
              const dragImg = li.cloneNode(true);
              dragImg.style.position = 'absolute';
              dragImg.style.top = '-1000px';
              dragImg.style.left = '-1000px';
              document.body.appendChild(dragImg);
              e.dataTransfer.setDragImage(dragImg, 10, 10);
              setTimeout(() => document.body.removeChild(dragImg), 0);
            } catch (err) { /* ignore */ }
          }
        } catch (err) {
          console.warn('dragstart 처리 중 오류:', err);
        }
      });
    }

    // 사이드바 토글 — use same collapsed state + persistence + BroadcastChannel sync
    if (els.sidebarToggle) {
      // initialize from localStorage
      try{
        const v = localStorage.getItem('ps_sidebar_collapsed');
        if(v === '1' || v === 'true') { if(els.sidebar) els.sidebar.classList.add('collapsed'); }
        else { if(els.sidebar) els.sidebar.classList.remove('collapsed'); }
      }catch(e){}

      // listen for external changes
      try{
        if(typeof BroadcastChannel !== 'undefined'){
          const bc = new BroadcastChannel('paperscout-sync');
          bc.onmessage = (ev)=>{
            try{
              const d = ev.data;
              // ignore our own messages
              if(!d || d.sender === WINDOW_ID) return;
              if(d && d.type === 'sidebar-collapsed'){
                if(els.sidebar){ if(d.collapsed) els.sidebar.classList.add('collapsed'); else els.sidebar.classList.remove('collapsed'); }
                if(els.sidebarToggle) els.sidebarToggle.setAttribute('aria-expanded', String(!(d.collapsed)));
                try{ localStorage.setItem('ps_sidebar_collapsed', d.collapsed ? '1' : '0'); }catch(e){}
              }
            }catch(e){}
          };
        }
      }catch(e){}

      els.sidebarToggle.addEventListener('click', () => {
        try{
          if (!els.sidebar) return;
          const collapsed = els.sidebar.classList.toggle('collapsed');
          els.sidebarToggle.setAttribute('aria-expanded', String(!collapsed));
          try{ localStorage.setItem('ps_sidebar_collapsed', collapsed ? '1' : '0'); }catch(e){}
          try{ if(typeof BroadcastChannel !== 'undefined'){ const bc = new BroadcastChannel('paperscout-sync'); bc.postMessage({ type:'sidebar-collapsed', collapsed: !!collapsed, sender: WINDOW_ID }); bc.close(); } }catch(e){}
        }catch(e){ console.warn('sidebarToggle click failed', e); }
      });
    }

    // 사이드바 목록 클릭
    if (els.userLists) {
      els.userLists.addEventListener('click', (e) => {
        const li = e.target.closest('.user-list-item');
        if (!li) return;
        
        const listId = li.dataset.id;
        
        if (e.target.classList.contains('js-delete')) {
          e.preventDefault();
          e.stopPropagation();
          if (confirm('이 목록을 삭제하시겠습니까?')) {
            deleteList(listId);
          }
        } else if (e.target.classList.contains('js-add-child')) {
          e.preventDefault();
          e.stopPropagation();
          const name = prompt('하위 목록 이름을 입력하세요:');
          if (name && name.trim()) {
            addChildList(listId, name.trim());
          }
        } else if (e.target.classList.contains('js-add-pdf')) {
          e.preventDefault();
          e.stopPropagation();
          // PDF 업로드 다이얼로그 열기 - 특정 목록에 추가하도록 pendingPdfParentId 설정
          pendingPdfParentId = listId;
          if (els.uploadPdf) {
            els.uploadPdf.click();
          } else {
            showToast('PDF 업로드 기능을 사용할 수 없습니다.', 'error');
          }
        } else {
          // 목록 선택
          state.selectedListId = listId;
          window.state.selectedListId = listId; // 전역 상태에도 저장
          saveWindowState(); // 상태 저장
          renderSidebar();
        }
      });
    }

    // 새 목록 추가
    if (els.addListBtn) {
      els.addListBtn.addEventListener('click', () => {
        const name = els.newListName.value.trim();
        if (name) {
          addNewList(name);
          els.newListName.value = '';
        }
      });
    }

    if (els.newListName) {
      els.newListName.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          const name = e.target.value.trim();
          if (name) {
            addNewList(name);
            e.target.value = '';
          }
        }
      });
    }

    // PDF 파일 업로드 처리
    if (els.uploadPdf) {
      els.uploadPdf.addEventListener('change', async (e) => {
        const files = e.target.files;
        if (files && files.length > 0) {
          const file = files[0];
          if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
            try {
              await handlePdfFile(file);
              showToast('PDF 파일이 추가되었습니다.');
            } catch (error) {
              console.error('PDF 파일 처리 실패:', error);
              showToast('PDF 파일 처리 중 오류가 발생했습니다.', 'error');
            }
          } else {
            showToast('PDF 파일만 업로드할 수 있습니다.', 'error');
          }
        }
        // 파일 선택 초기화
        e.target.value = '';
      });
    }
  }

  // 출판사 선택 토글 함수 (app.js 방식)
  window.togglePublisherSelection = function(publisherId) {
    console.log('🏢 출판사 선택/해제:', publisherId);
    console.log('🏢 변경 전 state.selectedPublishers:', Array.from(state.selectedPublishers || []));
    
    if (state.selectedPublishers.has(publisherId)) {
      state.selectedPublishers.delete(publisherId);
      console.log('🏢 출판사 제거됨:', publisherId);
    } else {
      state.selectedPublishers.add(publisherId);
      console.log('🏢 출판사 추가됨:', publisherId);
    }
    
    console.log('🏢 변경 후 state.selectedPublishers:', Array.from(state.selectedPublishers || []));
    
    // 로컬스토리지에 저장하여 새로고침 없이 유지
    try {
      localStorage.setItem('selectedPublishers', JSON.stringify(Array.from(state.selectedPublishers)));
    } catch (e) {
      console.warn('localStorage에 저장 실패:', e);
    }

    // 메뉴 및 로고 업데이트
    renderPublisherList();
    updateSelectedPublisherLogos();
  };
  window.showPublisherModal = async function() {
    console.log('📚 출판사 모달 표시 - 호출 스택:', new Error().stack);
    
    // 🔥 MODAL 열기 승인 플래그 설정
    window._allowModalOpen = true;
    console.log('📚 modal 열기 승인 플래그 설정');
    
    try {
      // 출판사 데이터 로드
      await loadPublishersData();
      
      // 출판사 목록 렌더링
      renderPublisherList();
      
      // 모달 표시
      if (els.publisherDialog) {
        // Clear any previously scheduled hide timeout (from init or prior calls)
        try {
          if (els.publisherDialog._hideTimeout) {
            clearTimeout(els.publisherDialog._hideTimeout);
            els.publisherDialog._hideTimeout = null;
          }
        } catch (e) {
          console.warn('이전 모달 hide 타이머 정리 실패:', e);
        }
        console.log('📚 모달 열기 전 상태:', {
          open: els.publisherDialog.open,
          hidden: els.publisherDialog.hidden
        });
        
        // Ensure any previous hidden/display styles are cleared so the
        // dialog is actually visible (important for headless browsers).
        try {
          els.publisherDialog.hidden = false;
          els.publisherDialog.style.display = '';
        } catch (e) {
          console.warn('모달 표시 전 스타일 초기화 실패:', e);
        }

        els.publisherDialog.showModal();

        console.log('📚 모달 연 후 상태:', {
          open: els.publisherDialog.open,
          hidden: els.publisherDialog.hidden,
          display: window.getComputedStyle ? window.getComputedStyle(els.publisherDialog).display : 'unknown'
        });
        
        // 모달이 표시된 후에 이벤트 리스너 추가
        setTimeout(() => {
          console.log('📚 이벤트 리스너 설정 시작');
          
          // 기존 이벤트 리스너들을 정리하기 위해 모달에 데이터 속성으로 저장
          if (!els.publisherDialog._modalEventHandlers) {
            els.publisherDialog._modalEventHandlers = [];
          }
          
          // 이전 이벤트 리스너들 제거
          els.publisherDialog._modalEventHandlers.forEach(handler => {
            if (handler.element && handler.event && handler.func) {
              handler.element.removeEventListener(handler.event, handler.func);
            }
          });
          els.publisherDialog._modalEventHandlers = [];
          
          // 모달 배경 클릭으로 닫기
          const modalClickHandler = (e) => {
            console.log('📚 배경 클릭 이벤트 발생:', e.target, e.currentTarget);
            if (e.target === els.publisherDialog) {
              console.log('📚 모달 배경 클릭으로 닫기');
              window.hidePublisherModal();
            }
          };
          els.publisherDialog.addEventListener('click', modalClickHandler);
          els.publisherDialog._modalEventHandlers.push({
            element: els.publisherDialog,
            event: 'click',
            func: modalClickHandler
          });
          
          // 닫기 버튼들에 이벤트 리스너 추가
          const closeButtons = els.publisherDialog.querySelectorAll('.publisher-dialog__close');
          console.log('📚 닫기 버튼들 찾음:', closeButtons.length, '개');
          
          closeButtons.forEach((btn, index) => {
            const closeHandler = (e) => {
              e.preventDefault();
              e.stopPropagation();
              console.log(`📚 닫기 버튼 ${index} 클릭`);
              window.hidePublisherModal();
            };
            btn.addEventListener('click', closeHandler);
            els.publisherDialog._modalEventHandlers.push({
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
    }
  };

  window.hidePublisherModal = function() {
    console.log('📚 출판사 모달 숨김 시도 - 현재 상태:', {
      dialog: !!els.publisherDialog,
      open: els.publisherDialog?.open,
      hasCloseMethod: typeof els.publisherDialog?.close === 'function'
    });
    
    // 🔥 MODAL 열기 승인 플래그 해제
    window._allowModalOpen = false;
    console.log('📚 modal 열기 승인 플래그 해제');
    
    if (els.publisherDialog) {
      try {
        // 이벤트 리스너들 정리
        if (els.publisherDialog._modalEventHandlers) {
          console.log('📚 이벤트 리스너 정리:', els.publisherDialog._modalEventHandlers.length, '개');
          els.publisherDialog._modalEventHandlers.forEach(handler => {
            if (handler.element && handler.event && handler.func) {
              handler.element.removeEventListener(handler.event, handler.func);
            }
          });
          els.publisherDialog._modalEventHandlers = [];
        }
        
        // 모달 닫기 시도
        if (els.publisherDialog.open) {
          console.log('📚 dialog.close() 호출');
          els.publisherDialog.close();
        } else {
          console.log('📚 모달이 이미 닫혀있음');
        }
        
        // 🔥 추가 안전장치: 강제로 hidden 속성 설정
        els.publisherDialog.hidden = true;
        console.log('📚 modal hidden 속성 강제 설정');
        
        // 추가 확인: 일정 시간이 지난 뒤에도 닫히지 않으면 강제 닫기
        // 해당 타이머는 나중에 모달을 다시 열 때 clear될 수 있다.
        if (els.publisherDialog._hideTimeout) {
          clearTimeout(els.publisherDialog._hideTimeout);
        }
        els.publisherDialog._hideTimeout = setTimeout(() => {
          try {
            console.log('📚 모달 닫기 후 상태:', {
              open: els.publisherDialog.open,
              hidden: els.publisherDialog.hidden
            });

            // 🔥 최종 확인: 여전히 열려있으면 강제 닫기
            if (els.publisherDialog.open) {
              console.log('📚 모달이 여전히 열려있음 - 최종 강제 닫기');
              try {
                els.publisherDialog.close();
                els.publisherDialog.hidden = true;
                els.publisherDialog.style.display = 'none';
              } catch (error) {
                console.error('📚 최종 강제 닫기 실패:', error);
              }
            }
          } finally {
            if (els.publisherDialog) els.publisherDialog._hideTimeout = null;
          }
        }, 100);
        
      } catch (error) {
        console.error('📚 모달 닫기 실패:', error);
        // fallback: 강제로 hidden 속성 설정
        els.publisherDialog.style.display = 'none';
        els.publisherDialog.hidden = true;
        console.log('📚 fallback: display none 및 hidden 적용');
      }
    } else {
      console.error('📚 모달 요소를 찾을 수 없음');
    }
  }

  window.renderPublisherList = function() {
    if (!els.publisherList || !publishersData) {
      console.error('출판사 목록 렌더링 실패: 요소 또는 데이터 없음');
      return;
    }
    
    console.log('📚 출판사 목록 렌더링:', publishersData);
    console.log('📚 현재 선택된 출판사:', Array.from(state.selectedPublishers || []));
    
    let html = '';
    
    if (publishersData.publishers && publishersData.publishers.length > 0) {
      for (const publisher of publishersData.publishers) {
        const isSelected = (state.selectedPublishers && state.selectedPublishers.has(publisher.id));
        console.log(`📚 ${publisher.name} 선택 상태:`, isSelected);
        const logo = publisher.logo || '📚';
        const color = publisher.color || '#6b7280';
        const shortName = publisher.shortName || publisher.name;
        const accessBadge = publisher.access ? `<span class="publisher-access-badge ${publisher.access}">${publisher.access === 'open' ? '무료' : '유료'}</span>` : '';
        
        html += `<button class="publisher-search-item ${isSelected ? 'selected' : ''}" 
                        data-publisher-id="${publisher.id}" 
                        title="${shortName} 선택">
          <span class="publisher-search-logo" style="background-color: ${color}">${logo}</span>
          <span class="publisher-search-name">${escapeHtml(shortName)}</span>
          ${accessBadge}
          ${isSelected ? '<span class="selection-indicator">✓</span>' : ''}
        </button>`;
      }
    } else {
      html = '<p>출판사 데이터를 불러올 수 없습니다.</p>';
      console.error('출판사 데이터가 비어있습니다:', publishersData);
    }
    
    els.publisherList.innerHTML = html;
    
    // 이벤트 리스너 추가
    const publisherButtons = els.publisherList.querySelectorAll('.publisher-search-item');
    publisherButtons.forEach(button => {
      button.addEventListener('click', (e) => {
        e.preventDefault();
        const publisherId = button.getAttribute('data-publisher-id');
        console.log('📚 출판사 버튼 클릭:', publisherId);
        togglePublisherSelection(publisherId);
      });
    });
    
    console.log('📚 출판사 목록 HTML 업데이트 및 이벤트 리스너 추가 완료');
  }

  window.selectAllPublishers = function() {
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

  window.clearAllPublishers = function() {
    if (!state.selectedPublishers) {
      state.selectedPublishers = new Set();
    } else {
      state.selectedPublishers.clear();
    }
    
    renderPublisherList();
  }

  window.applyPublisherSelection = async function() {
    console.log('📚 출판사 선택 적용:', Array.from(state.selectedPublishers || []));
    
    // 출판사 데이터 로드 확인
    await loadPublishersData();
    
    // URL 업데이트
    updateUrlWithPublishers();
    // 로컬스토리지에 저장 (즉시 반영 및 새로고침 후 유지)
    try {
      localStorage.setItem('selectedPublishers', JSON.stringify(Array.from(state.selectedPublishers)));
    } catch (e) {
      console.warn('selectedPublishers localStorage 저장 실패:', e);
    }
    
    // 모달 닫기
    window.hidePublisherModal();
    
    // 검색 재실행
    await search();
    
    // 선택된 출판사 로고 업데이트 (검색 완료 후)
    updateSelectedPublisherLogos();
    
    showToast('출판사 필터가 적용되었습니다.');
  }

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
  if (state.pageSize && state.pageSize !== 20) params.set('pageSize', state.pageSize);
    if (state.yFrom) params.set('yFrom', state.yFrom);
    if (state.yTo) params.set('yTo', state.yTo);
    if (state.journal) params.set('journal', state.journal);
    
    const newUrl = `${window.location.pathname}?${params.toString()}`;
    history.replaceState({}, '', newUrl);
  }

  // 목록에 추가
  async function addToList(item) {
    if (!item) return;
    
    if (!state.selectedListId) {
      showToast('먼저 목록을 선택해주세요.');
      return;
    }
    
    const node = {
      id: crypto.randomUUID(),
      name: item.title || '문서',
      remoteUrl: item.url || null,
      type: 'pdf',
      children: []
    };
    
    if (window.ListCore) {
      try {
        // ListCore를 통해 목록에 추가
        const success = await window.ListCore.addNodeToParent(state.selectedListId, node);
        if (success) {
          showToast('목록에 추가되었습니다.');
        } else {
          showToast('목록 추가에 실패했습니다.', 'error');
        }
      } catch (error) {
        console.error('목록 추가 실패:', error);
        showToast('목록 추가 중 오류가 발생했습니다.', 'error');
      }
    } else {
      showToast('목록 관리 기능을 사용할 수 없습니다.', 'error');
    }
  }

  // 새 목록 추가
  async function addNewList(name) {
    if (window.ListCore) {
      try {
        await window.ListCore.addList(name);
        showToast('새 목록이 추가되었습니다.');
      } catch (error) {
        console.error('목록 추가 실패:', error);
        showToast('목록 추가에 실패했습니다.', 'error');
      }
    }
  }

  // 하위 목록 추가
  async function addChildList(parentId, name) {
    if (window.ListCore) {
      try {
        await window.ListCore.addList(name, parentId);
        showToast('하위 목록이 추가되었습니다.');
      } catch (error) {
        console.error('하위 목록 추가 실패:', error);
        showToast('하위 목록 추가 중 오류가 발생했습니다.', 'error');
      }
    }
  }

  // 목록 삭제
  async function deleteList(listId) {
    if (window.ListCore) {
      try {
        const success = await window.ListCore.deleteList(listId);
        if (success) {
          showToast('목록이 삭제되었습니다.');
          if (state.selectedListId === listId) {
            state.selectedListId = null;
            window.state.selectedListId = null; // 전역 상태에도 초기화
          }
          saveWindowState(); // 상태 저장
        } else {
          showToast('목록 삭제에 실패했습니다.', 'error');
        }
      } catch (error) {
        console.error('목록 삭제 실패:', error);
        showToast('목록 삭제 중 오류가 발생했습니다.', 'error');
      }
    }
  }

  // DOI 복사
  function copyDoi(item) {
    if (!item || !item.doi) return;
    navigator.clipboard.writeText(item.doi).then(() => {
      showToast('DOI가 복사되었습니다.');
    });
  }

  // 검색 결과에서 제목 클릭 시 PDF 뷰어 열기
  function openPdf(item) {
    if (!item) return;

    // 우선 fileId가 있으면 IndexedDB에서 로드하도록 fileId 전달
    const params = new URLSearchParams();
    if (item.fileId) {
      params.set('fileId', item.fileId);
    } else if (item.url) {
      // 원격 URL의 경우: 먼저 probe 결과가 있으면 서버 프록시를 통해 전달 (CORS 회피 및 안정성)
      const uploadEndpoint = localStorage.getItem('uploadEndpoint') || localStorage.getItem('uploadendpoint') || localStorage.getItem('uploadEndpoint');
      let finalUrl = item.url;
      try {
        const proxyBase = `${window.location.protocol}//${window.location.hostname}:3001`;
        // if probe detected PDF, prefer server proxy to avoid CORS issues when loading in PDF viewer
        if (item.__probe === 'pdf') {
          finalUrl = `${proxyBase}/proxy?url=${encodeURIComponent(item.url)}`;
        } else if (uploadEndpoint && uploadEndpoint.trim()) {
          finalUrl = `${uploadEndpoint.replace(/\/$/, '')}/proxy?url=${encodeURIComponent(item.url)}`;
        }
      } catch (e) {
        console.warn('openPdf: proxy 구성 확인 실패, 직접 URL 사용', e);
      }
      params.set('url', encodeURIComponent(finalUrl));
    } else {
      showToast('열 수 있는 PDF 정보가 없습니다.', 'error');
      return;
    }

    // 검색 상태를 보존해서 뒤로가기 시 복원 가능하게 함
    if (state.q) params.set('q', state.q);
    if (state.sort && state.sort !== 'relevance') params.set('sort', state.sort);
    if (state.page && state.page !== 1) params.set('page', state.page);
    if (state.yFrom) params.set('yFrom', state.yFrom);
    if (state.yTo) params.set('yTo', state.yTo);
    if (state.journal) params.set('journal', state.journal);
    if (state.selectedPublishers && state.selectedPublishers.size > 0) {
      params.set('publishers', Array.from(state.selectedPublishers).join(','));
    }

    const viewerUrl = `/pdf-viewer.html?${params.toString()}`;
    // 같은 탭에서 PDF 뷰어로 이동
    window.location.href = viewerUrl;
  }

  // PDF 파일 처리
  async function handlePdfFile(file) {
    if (!file) return;
    
    // 파일 ID 생성
    const fileId = crypto.randomUUID();
    
    // 파일 시그니처 계산 (중복 방지용)
    let fileSignature = null;
    try {
      fileSignature = await hashBlob(file);
    } catch (e) {
      console.warn('파일 시그니처 계산 실패:', e);
    }
    
    // IndexedDB에 파일 저장
    try {
      await dbPutFile(fileId, file);
    } catch (e) {
      console.warn('파일 저장 실패:', e);
      showToast('파일 저장에 실패했습니다.', 'error');
      return;
    }
    
    // PDF 노드 생성
    const pdfNode = {
      id: crypto.randomUUID(),
      name: file.name,
      fileId: fileId,
      fileSignature: fileSignature,
      type: 'pdf',
      children: []
    };
    
    // 선택된 목록에 추가 (또는 기본 목록 생성)
    console.log('📁 PDF 추가 - 현재 선택된 목록:', state.selectedListId);
    console.log('📁 PDF 추가 - pending 목록:', pendingPdfParentId);
    console.log('📁 PDF 추가 - 사용자 목록들:', state.userLists.map(l => ({ id: l.id, name: l.name })));
    
    let parentId = pendingPdfParentId || state.selectedListId;
    if (!parentId || !findNodeById(state.userLists, parentId)) {
      console.log('📁 선택된 목록이 없거나 유효하지 않음');
      showToast('PDF를 추가할 목록을 먼저 선택해주세요.', 'error');
      return; // PDF 추가 중단
    } else {
      console.log('📁 사용할 목록:', parentId);
    }
    
    // 목록에 PDF 추가
    try {
      await addNodeToParent(parentId, pdfNode);
      showToast('PDF 파일이 목록에 추가되었습니다.');
      // pendingPdfParentId 초기화
      pendingPdfParentId = null;
    } catch (error) {
      console.error('PDF 추가 실패:', error);
      showToast('PDF 파일 추가에 실패했습니다.', 'error');
      // 실패 시에도 초기화
      pendingPdfParentId = null;
    }
    
    // 자동 업로드 (설정된 경우)
    try {
      const ep = localStorage.getItem('uploadEndpoint');
      const auto = localStorage.getItem('autoUpload') === 'true';
      if (ep && auto) {
        uploadBlobToServer(fileId, pdfNode, ep).catch(e => console.warn('자동 업로드 실패:', e));
      }
    } catch (e) {
      console.warn('자동 업로드 설정 확인 실패:', e);
    }
  }

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

  // 유틸리티 함수들
  async function hashBlob(blob) {
    try {
      const ab = await blob.arrayBuffer();
      const hashBuffer = await crypto.subtle.digest('SHA-1', ab);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const hex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
      return hex;
    } catch (e) {
      console.warn('hashBlob 실패:', e);
      return null;
    }
  }

  async function dbPutFile(key, blob) {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction('files', 'readwrite');
      const store = tx.objectStore('files');
      const rq = store.put(blob, key);
      rq.onsuccess = () => {
        tx.oncomplete = () => {
          db.close();
          res(true);
        };
      };
      rq.onerror = () => {
        db.close();
        rej(rq.error);
      };
    });
  }

  function openDB() {
    return new Promise((res, rej) => {
      const req = indexedDB.open('paperscout', 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) {
          db.createObjectStore('kv');
        }
        if (!db.objectStoreNames.contains('files')) {
          db.createObjectStore('files');
        }
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }

  function findListByName(lists, name) {
    for (const list of lists) {
      if (list.name === name) return list;
      if (list.children && list.children.length > 0) {
        const found = findListByName(list.children, name);
        if (found) return found;
      }
    }
    return null;
  }

  function findNodeById(lists, id) {
    for (const list of lists) {
      if (list.id === id) return list;
      if (list.children && list.children.length > 0) {
        const found = findNodeById(list.children, id);
        if (found) return found;
      }
    }
    return null;
  }

  // window.state를 IndexedDB에 저장
  async function saveWindowState() {
    try {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('kv', 'readwrite');
        const store = tx.objectStore('kv');
        const req = store.put(window.state, 'windowState');
        req.onsuccess = () => {
          tx.oncomplete = () => {
            db.close();
            resolve(true);
          };
        };
        req.onerror = () => {
          db.close();
          reject(req.error);
        };
      });
    } catch (error) {
      console.error('window.state 저장 실패:', error);
      return false;
    }
  }

  // window.state를 IndexedDB에서 불러오기
  async function loadWindowState() {
    try {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('kv', 'readonly');
        const store = tx.objectStore('kv');
        const req = store.get('windowState');
        req.onsuccess = () => {
          const savedState = req.result;
          if (savedState) {
            // 불러온 상태로 window.state 업데이트
            window.state = { ...window.state, ...savedState };
          }
          tx.oncomplete = () => {
            db.close();
            resolve(window.state);
          };
        };
        req.onerror = () => {
          db.close();
          reject(req.error);
        };
      });
    } catch (error) {
      console.error('window.state 불러오기 실패:', error);
      return window.state;
    }
  }

  async function addNodeToParent(parentId, node) {
    console.log('📁 addNodeToParent 호출:', { parentId, node: { id: node.id, name: node.name } });
    if (window.ListCore) {
      try {
        // search-results 페이지에서는 render를 호출하지 않도록 save 옵션을 false로 설정
        console.log('📁 insertAtIndex 호출 전 상태:', {
          listsLength: window.state.userLists.length,
          parentId,
          nodeId: node.id
        });
        const success = await window.ListCore.insertAtIndex(window.state.userLists, parentId, null, node, { save: false });
        if (success) {
          console.log('📁 insertAtIndex 성공');
          // 수동으로 저장
          console.log('📁 saveChanges 호출');
          await window.ListCore.saveChanges(window.state.userLists);
          console.log('📁 saveChanges 완료');
          // ListCore 상태 동기화
          state.userLists = window.ListCore.state.lists;
          console.log('📁 상태 동기화 완료, 목록 수:', state.userLists.length);
          // UI 갱신
          renderSidebar();
          console.log('📁 UI 갱신 완료');
          return true;
        } else {
          console.log('📁 insertAtIndex 실패');
        }
      } catch (error) {
        console.error('📁 addNodeToParent 실패:', error);
      }
    } else {
      console.error('📁 ListCore 없음');
    }
    return false;
  }

  async function uploadBlobToServer(fileId, node, endpoint) {
    try {
      const db = await openDB();
      const blob = await new Promise((res, rej) => {
        const tx = db.transaction('files', 'readonly');
        const store = tx.objectStore('files');
        const rq = store.get(fileId);
        rq.onsuccess = () => res(rq.result);
        rq.onerror = () => rej(rq.error);
      });
      db.close();
      
      if (!blob) throw new Error('파일을 찾을 수 없습니다');
      
      const formData = new FormData();
      formData.append('file', blob, node.name);
      
      const response = await fetch(`${endpoint}/upload`, {
        method: 'POST',
        body: formData
      });
      
      if (!response.ok) throw new Error(`업로드 실패: ${response.status}`);
      
      const result = await response.json();
      console.log('서버 업로드 성공:', result);
      
      // 노드에 서버 URL 추가
      node.remoteUrl = result.url;
      
      return result;
    } catch (error) {
      console.error('서버 업로드 실패:', error);
      throw error;
    }
  }

  // 초기화
  async function init() {
    console.log('📄 검색 결과 페이지 초기화');
    console.log('📄 현재 URL:', window.location.href);
    console.log('📄 URL 파라미터:', window.location.search);

    // 🔥 MODAL 초기화: 페이지 로드 시 모든 모달 강제 닫기
    console.log('🔥 MODAL 초기화: 검색 결과 페이지에서 모든 모달 강제 닫기');
    try {
      if (els.publisherDialog && els.publisherDialog.open) {
        console.log('📚 출판사 모달이 열려있음 - 강제 닫기');
        window.hidePublisherModal();
      }
    } catch (error) {
      console.warn('📚 모달 초기화 실패:', error);
    }

    // 출판사 데이터 로드
    await loadPublishersData();
    console.log('📚 출판사 데이터 로드 완료');

    // DOM 요소 확인
    checkDOMElements();

    // 모달 초기 상태 확인 및 숨김 - 수정: 실제로 모달 닫기
    if (els.publisherDialog) {
      console.log('📚 출판사 모달 강제 숨김');
      window.hidePublisherModal();
    }

    parseUrlParams();
    updateSelectedPublisherLogos();

    // 폼 초기화
    initializeForm();

    setupEventListeners();
    await initSidebar();

    console.log('📄 검색어 확인:', state.q, '길이:', state.q.length);

    if (state.q && state.q.trim()) {
      console.log('📄 검색어 있음 - 검색 실행');
      await search();
    } else {
      console.log('📄 검색어 없음 - 빈 결과 표시');
      // 검색어가 없으면 빈 결과 표시 (리다이렉트하지 않음)
      state.items = [];
      state.total = 0;
      renderResults();
    }
  }

  // 페이지 로드 시 초기화
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 검색 폼 제출 처리
  function handleSearchSubmit() {
    console.log('🔍 검색 폼 제출 처리');
    
    // 폼 값들을 상태에 동기화
    syncFormToState();
    
    // URL 업데이트
    updateUrl();
    
    // 검색 실행
    search();
  }

  // 폼 값들을 상태에 동기화
  function syncFormToState() {
    if (els.q) state.q = els.q.value.trim();
    if (els.sort) state.sort = els.sort.value;
    if (els.yFrom) state.yFrom = els.yFrom.value.trim();
    if (els.yTo) state.yTo = els.yTo.value.trim();
    if (els.journal) state.journal = els.journal.value.trim();
    
    console.log('🔄 폼 값 상태 동기화:', state);
  }

  // 고급 옵션 토글
  function toggleAdvancedOptions() {
    if (!els.advancedOptions) return;
    
    const isVisible = els.advancedOptions.style.display !== 'none';
    if (isVisible) {
      els.advancedOptions.style.display = 'none';
      if (els.advancedToggle) els.advancedToggle.textContent = '고급';
    } else {
      els.advancedOptions.style.display = 'block';
      if (els.advancedToggle) els.advancedToggle.textContent = '기본';
    }
  }

  // URL 업데이트
  function updateUrl() {
    const params = new URLSearchParams();
    
    if (state.q) params.set('q', state.q);
    if (state.sort !== 'relevance') params.set('sort', state.sort);
    if (state.page !== 1) params.set('page', state.page);
    if (state.pageSize && state.pageSize !== 20) params.set('pageSize', state.pageSize);
    if (state.selectedPublishers && state.selectedPublishers.size > 0) {
      params.set('publishers', Array.from(state.selectedPublishers).join(','));
    }
    
    const newUrl = `${window.location.pathname}?${params.toString()}`;
    history.replaceState({}, '', newUrl);
    
    console.log('🔗 URL 업데이트:', newUrl);
  }

  // 폼 초기화
  function initializeForm() {
    console.log('📝 폼 초기화 시작');
    
    // 검색어 설정
    if (els.q) {
      els.q.value = state.q || '';
    }
    
    // 정렬 설정
    if (els.sort) {
      els.sort.value = state.sort || 'relevance';
    }
    
    console.log('📝 폼 초기화 완료');
    // 프록시 사용 초기 상태 설정 (localStorage 기반)
    try {
      const useProxyLs = localStorage.getItem('useProxy');
      if (typeof useProxyLs === 'string') {
        window.usePublisherProxy = useProxyLs === 'true';
      } else {
        // 기본값은 true (개발 환경에서 편리하도록)
        window.usePublisherProxy = true;
        localStorage.setItem('useProxy', 'true');
      }
      if (els.useProxyToggle) els.useProxyToggle.checked = !!window.usePublisherProxy;
    } catch (e) {
      console.warn('프록시 초기 상태 읽기 실패:', e);
      window.usePublisherProxy = true;
    }
    updateProxyStatusUI();
  }

  // 프록시 상태 UI 업데이트
  function updateProxyStatusUI() {
    try {
      const enabled = !!window.usePublisherProxy;
      if (els.proxyStatus) {
        els.proxyStatus.textContent = enabled ? '서버 프록시 사용: 활성화됨 (CORS/인증 문제 시 권장)' : '서버 프록시 사용: 비활성화됨 (직접 호출 시 CORS 오류 발생할 수 있음)';
        els.proxyStatus.style.color = enabled ? '#065f46' : '#92400e';
      }
    } catch (e) {
      console.warn('updateProxyStatusUI 실패:', e);
    }
  }

  // 선택된 출판사 로고 업데이트 (중앙 구현)
  function updateSelectedPublisherLogos() {
    if (!els.selectedPublisherLogos || !publishersData) return;

    const selectedPublisherIds = Array.from(state.selectedPublishers || []);
    if (selectedPublisherIds.length === 0) {
      els.selectedPublisherLogos.innerHTML = '';
      return;
    }

    let logosHtml = '';
    for (const publisherId of selectedPublisherIds) {
      const publisher = (publishersData.publishers || []).find(p => p.id === publisherId);
      if (publisher) {
        const color = publisher.color || '#6b7280';
        const logo = publisher.logo || '📚';
        const title = publisher.name || publisherId;
        logosHtml += `<div class="selected-publisher-logo" style="background-color: ${color}" data-publisher-id="${publisherId}" title="${escapeHtml(title)} 제거">${logo}</div>`;
      }
    }

    els.selectedPublisherLogos.innerHTML = logosHtml;

    // 클릭 이벤트 추가 (로고 클릭 시 제거)
    els.selectedPublisherLogos.querySelectorAll('.selected-publisher-logo').forEach(logoEl => {
      // remove previous handlers by cloning node to avoid duplicate listeners
      const node = logoEl.cloneNode(true);
      logoEl.parentNode.replaceChild(node, logoEl);
      node.addEventListener('click', (e) => {
        const publisherId = node.getAttribute('data-publisher-id');
        if (publisherId) {
          state.selectedPublishers.delete(publisherId);
          try {
            localStorage.setItem('selectedPublishers', JSON.stringify(Array.from(state.selectedPublishers)));
          } catch (err) {
            console.warn('localStorage 저장 실패:', err);
          }
          updateUrlWithPublishers();
          updateSelectedPublisherLogos();
          // 재검색 (비동기) — 사용자가 즉시 변경을 보게 함
          search();
        }
      });
    });
  }
  