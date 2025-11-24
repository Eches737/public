'use strict';

// Debug logging
const debug = (...args) => console.log('[ListCore]', ...args);

// Utilities
function ensureElement(el) {
  return el instanceof Element ? el : null;
}

function findNode(id, list) {
  if (!Array.isArray(list)) return null;
  for (const item of list) {
    if (item.id === id) return item;
    if (item.children) {
      const found = findNode(id, item.children);
      if (found) return found;
    }
  }
  return null;
}

function removeNode(id, list) {
  if (!Array.isArray(list)) return null;
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === id) {
      return list.splice(i, 1)[0];
    }
    if (list[i].children) {
      const found = removeNode(id, list[i].children);
      if (found) return found;
    }
  }
  return null;
}

function createListItem(data, parentId) {
  if (!data?.id) return null;

  const li = document.createElement('li');
  li.className = 'user-list-item';
  li.setAttribute('data-id', data.id);
  li.draggable = true;
  
  if (parentId) {
    li.setAttribute('data-parent-id', parentId);
  }

  // Add label
  const span = document.createElement('span');
  span.textContent = data.name || 'Untitled';
  span.className = 'user-list-item-label';
  li.appendChild(span);

  // Always create nested list container for potential children
  const ul = document.createElement('ul');
  ul.className = 'user-lists--nested';
  
  if (Array.isArray(data.children) && data.children.length > 0) {
    data.children.forEach(child => {
      const childEl = createListItem(child, data.id);
      if (childEl) ul.appendChild(childEl);
    });
  }
  
  li.appendChild(ul);
  return li;
}

// Core implementation
window.ListCore = {
  initialized: false,
  draggedItem: null,
  root: null,
  lastEventId: null,
  _rendering: false,
  
  // State management
  state: {
    lists: [],
    selectedId: null
  },
  
  // Event system
  _listeners: new Map(),
  
  on(eventName, callback) {
    if (!this._listeners.has(eventName)) {
      this._listeners.set(eventName, new Set());
    }
    this._listeners.get(eventName).add(callback);
  },
  
  off(eventName, callback) {
    if (this._listeners.has(eventName)) {
      this._listeners.get(eventName).delete(callback);
    }
  },
  
  emit(eventName, data) {
    if (this._listeners.has(eventName)) {
      this._listeners.get(eventName).forEach(callback => {
        try {
          callback(data);
        } catch (err) {
          console.error(`Error in ${eventName} listener:`, err);
        }
      });
    }
  },
  
  // Core list operations
  async addList(name, parentId = null) {
    if (!name?.trim()) {
      throw new Error('Name is required');
    }
    
    const node = {
      id: crypto.randomUUID(),
      name: name.trim(),
      children: []
    };
    
    await this.insertAtIndex(this.state.lists, parentId, undefined, node, { save: true });
    this.state.selectedId = node.id;
    
    // Emit events
    this.emit('listAdded', { node, parentId });
    this.emit('stateChanged', { type: 'add', node, parentId });
    
    // Trigger immediate render
    await this.render();
    
    return node;
  },
  
  // Helper function to find the first list ID
  findFirstId(lists) {
    if (!Array.isArray(lists) || lists.length === 0) return null;
    return lists[0].id || null;
  },
  
  async deleteList(id) {
    if (!id) return false;
    const removed = this.findAndRemoveNode(this.state.lists, id);
    if (removed) {
      if (this.state.selectedId === id) {
        this.state.selectedId = this.findFirstId(this.state.lists);
      }
      // Emit events before saving
      this.emit('listDeleted', { node: removed, id });
      this.emit('stateChanged', { type: 'delete', node: removed, id });
      
      await this.saveChanges(this.state.lists);
      await this.render();
      
      return true;
    }
    return false;
  },
  
  setSelectedId(id) {
    this.state.selectedId = id;
  },
  
  // Event tracking
  eventMap: new WeakMap(),

  // Node manipulation methods
  async insertAtIndex(lists, parentId, index, node, options = {}) {
    if (!Array.isArray(lists)) {
      throw new Error('lists must be an array');
    }
    if (!node?.id) {
      throw new Error('node must have an id');
    }

    // Find target parent list
    let targetList = lists;
    let parent = null;
    if (parentId) {
      parent = findNode(parentId, lists);
      if (!parent) {
        throw new Error(`Parent node ${parentId} not found`);
      }
      // Ensure parent has a children array
      parent.children = Array.isArray(parent.children) ? parent.children : [];
      targetList = parent.children;
      
      // Check maximum depth limit
      const maxDepth = options.maxDepth || 5; // Default maximum depth
      const currentDepth = this.getNodeDepth(lists, parentId);
      if (currentDepth >= maxDepth) {
        throw new Error(`Maximum depth limit exceeded. Cannot insert at depth ${currentDepth + 1} (max: ${maxDepth})`);
      }
    }

    // Create deep copy to avoid reference issues
    const nodeCopy = JSON.parse(JSON.stringify(node));

    // Insert at specified index or append
    if (typeof index === 'number' && index >= 0 && index <= targetList.length) {
      targetList.splice(index, 0, nodeCopy);
    } else {
      targetList.push(nodeCopy);
    }

    // Update internal state with deep copy to ensure immutability
    this.state.lists = JSON.parse(JSON.stringify(lists));

    // Save changes if not explicitly disabled
    if (options.save !== false) {
      try {
        // Use the internal state for saving to ensure consistency
        await this.saveChanges(this.state.lists);
        
        // Emit insert event
        this.emit('nodeInserted', {
          node: nodeCopy,
          parentId,
          index,
          parent
        });
        
        // Trigger UI update
        await this.render();
      } catch (err) {
        console.error('Failed to save after insert:', err);
        throw err;
      }
    }

    return true;
  },

  async moveNode(lists, nodeId, newParentId, newIndex, options = {}) {
    if (!Array.isArray(lists) || !nodeId) {
      throw new Error('Invalid arguments');
    }

    // Find and remove node
    const node = findNode(nodeId, lists);
    if (!node) {
      throw new Error(`Node ${nodeId} not found`);
    }

    // Check for moving into descendant
    if (this.isDescendant(node, newParentId, lists)) {
      throw new Error('Cannot move node into its own descendant');
    }

    // Store the original parent for event
    const originalParentId = this.findParentId(nodeId, lists);

    // Remove from current position
    removeNode(nodeId, lists);

    // Handle cloning if requested
    if (options.clone) {
      if (options.regenerateIds) {
        this.regenerateIds(node);
      }
    }

    // Insert at new location
    try {
      await this.insertAtIndex(lists, newParentId, newIndex, node, options);
      
      // Update internal state
      this.state.lists = lists;
      
      // Emit move event
      this.emit('nodeMoved', {
        node,
        fromParentId: originalParentId,
        toParentId: newParentId,
        newIndex
      });
      
      // Emit state change for UI sync
      this.emit('stateChanged', { 
        type: 'move', 
        node, 
        fromParentId: originalParentId, 
        toParentId: newParentId, 
        newIndex,
        lists 
      });
      
      // Ensure state change is saved to storage if save option is not false
      if (options.save !== false) {
        await this.saveChanges(lists);
      }
      
      // Trigger UI update only in browser environment
      if (typeof document !== 'undefined') {
        await this.render();
      }
      
      return true;
    } catch (err) {
      console.error('Move node failed:', err);
      throw err;
    }
  },

  async addNodeWithDupCheck(lists, parentId, node, options = {}) {
    if (!node || !Array.isArray(lists)) {
      throw new Error('Invalid arguments');
    }

    // PDF-specific validations
    if (node.type === 'pdf') {
      if (!node.remoteUrl && !node.fileSignature && !node.title) {
        throw new Error('PDF node must have either remoteUrl, fileSignature, or title');
      }
    }

    // Check for duplicates
    const duplicates = this.findDuplicates(lists, node);
    if (duplicates.length > 0) {
      throw new Error('duplicate: ' + duplicates[0].node.id);
    }

    // No duplicates found, try to insert
    try {
      await this.insertAtIndex(lists, parentId, null, node, options);
      return true;
    } catch (error) {
      throw error;
    }
  },

  // Enhanced node finding utilities
  findDuplicates(lists, node) {
    // Ensure we're working with a flat array of all nodes
    const allNodes = Array.isArray(lists) ? 
      this.getAllNodes({ children: lists }) :
      this.getAllNodes(lists);
    
    // Filter out the node itself if it exists in the list
    const otherNodes = allNodes.filter(n => n.id !== node.id);
    
    // Initialize duplicates array
    const duplicates = [];
    
    // For each node, check all possible duplicate conditions
    otherNodes.forEach(existingNode => {
      // Check URL duplicates (exact match)
      if (node.remoteUrl && existingNode.remoteUrl === node.remoteUrl) {
        duplicates.push({
          type: 'url',
          node: existingNode,
          match: 'exact'
        });
        return; // Skip further checks for this node
      }
      
      // Check file signature duplicates
      if (node.fileSignature && existingNode.fileSignature === node.fileSignature) {
        duplicates.push({
          type: 'signature',
          node: existingNode,
          match: 'exact'
        });
        return;
      }
      
      // Check title duplicates for PDFs
      if (node.type === 'pdf' && existingNode.type === 'pdf' &&
          node.title && existingNode.title === node.title) {
        duplicates.push({
          type: 'title',
          node: existingNode,
          match: 'exact'
        });
        return;
      }
    });
    
    return duplicates;
  },

  isDuplicateNode(lists, node) {
    if (!node || !Array.isArray(lists)) return false;
    
    // URL 중복 확인
    if (node.remoteUrl) {
      const urlMatch = this.findNodeByUrl(lists, node.remoteUrl);
      if (urlMatch && urlMatch.id !== node.id) return true;
    }
    
    // 파일 시그니처 중복 확인
    if (node.fileSignature) {
      const signatureMatch = this.findNodeBySignature(lists, node.fileSignature);
      if (signatureMatch && signatureMatch.id !== node.id) return true;
    }
    
    // PDF 타입의 경우 제목 중복 확인
    if (node.type === 'pdf' && node.title) {
      const titleMatches = this.getAllNodes({ children: lists }).filter(n => 
        n.id !== node.id && 
        n.type === 'pdf' && 
        n.title === node.title
      );
      if (titleMatches.length > 0) return true;
    }
    
    return false;
  },

  // Helper methods
  getNodeDepth(lists, nodeId) {
    if (!nodeId) return 0;
    let depth = 0;
    let currentId = nodeId;
    
    while (currentId) {
      const parent = this.findParentNode(lists, currentId);
      if (!parent) break;
      depth++;
      currentId = parent.id;
    }
    
    return depth;
  },

  isDescendant(node, ancestorId, lists) {
    // ancestorId가 node의 후손인지 확인
    // (즉, node를 ancestorId로 이동하면 순환 참조가 발생하는지 확인)
    if (!node || !ancestorId) return false;
    
    // node의 모든 후손을 확인하여 ancestorId가 있는지 체크
    const checkDescendants = (currentNode) => {
      if (!currentNode || !currentNode.children) return false;
      
      for (const child of currentNode.children) {
        if (child.id === ancestorId) return true;
        if (checkDescendants(child)) return true;
      }
      return false;
    };
    
    return checkDescendants(node);
  },

  findParentNode(lists, nodeId) {
    if (!Array.isArray(lists)) return null;
    for (const item of lists) {
      if (item.children?.some(child => child.id === nodeId)) {
        return item;
      }
      if (item.children) {
        const found = this.findParentNode(item.children, nodeId);
        if (found) return found;
      }
    }
    return null;
  },

  findParentId(nodeId, lists) {
    const parent = this.findParentNode(lists, nodeId);
    return parent ? parent.id : null;
  },

  getAllNodes(node) {
    const nodes = [];
    
    function collect(n) {
      if (!n) return;
      
      // Handle array input
      if (Array.isArray(n)) {
        n.forEach(item => collect(item));
        return;
      }
      
      // Add the current node
      nodes.push(n);
      
      // Process children if they exist
      if (Array.isArray(n.children)) {
        n.children.forEach(child => collect(child));
      }
    }
    
    // Start collection from input node or its children
    if (node?.children && !node.id) {
      collect(node.children);
    } else {
      collect(node);
    }
    
    return nodes;
  },

  findNodeByUrl(lists, url) {
    for (const node of this.getAllNodes({ children: lists })) {
      if (node.remoteUrl === url) return node;
    }
    return null;
  },

  findNodeBySignature(lists, signature) {
    for (const node of this.getAllNodes({ children: lists })) {
      if (node.fileSignature === signature) return node;
    }
    return null;
  },

  // Add missing methods required by app.js
  findNodeByFileId(lists, fileId) {
    if (!fileId || !Array.isArray(lists)) return null;
    for (const node of this.getAllNodes({ children: lists })) {
      if (node.fileId === fileId) return node;
    }
    return null;
  },

  findNodeByFileSignature(lists, signature) {
    if (!signature || !Array.isArray(lists)) return null;
    return this.findNodeBySignature(lists, signature);
  },

  async findNodeByFileSignatureAsync(lists, signature) {
    return this.findNodeByFileSignature(lists, signature);
  },

  findNodeById(lists, id) {
    if (!id || !Array.isArray(lists)) return null;
    return findNode(id, lists);
  },

  findAndRemoveNode(lists, id) {
    if (!id || !Array.isArray(lists)) return null;
    return removeNode(id, lists);
  },

  snapshotForNode(node) {
    if (!node) return null;
    
    // 기본 노드 정보 복사
    const snapshot = {
      id: node.id,
      name: node.name,
      type: node.type,
      children: []
    };

    // 선택적 필드들 복사
    if (node.remoteUrl) snapshot.remoteUrl = node.remoteUrl;
    if (node.fileSignature) snapshot.fileSignature = node.fileSignature;
    if (node.fileId) snapshot.fileId = node.fileId;
    if (node.size) snapshot.size = node.size;
    if (node.title) snapshot.title = node.title;

    // 자식 노드들 재귀적으로 처리
    if (Array.isArray(node.children)) {
      snapshot.children = node.children.map(child => this.snapshotForNode(child));
    }

    return snapshot;
  },

  regenerateIds(node) {
    if (!node) return;
    node.id = crypto.randomUUID();
    if (Array.isArray(node.children)) {
      node.children.forEach(child => this.regenerateIds(child));
    }
  },

  async saveChanges(lists) {
    try {
      debug('saveChanges called with', lists?.length, 'lists');
      
      // 🔍 저장 전 입력 데이터 로깅
      debug('saveChanges input lists:', JSON.stringify(lists, null, 2));
      
      // 깊은 복사로 상태 업데이트
      this.state.lists = JSON.parse(JSON.stringify(lists));
      
      // 🔄 중첩된 children까지 정규화하는 재귀 함수
      function normalizeItem(item) {
        const normalized = { ...item };
        if (!Array.isArray(normalized.children)) {
          normalized.children = [];
        } else {
          // 자식 항목들도 재귀적으로 정규화
          normalized.children = normalized.children.map(normalizeItem);
        }
        return normalized;
      }
      
      // IndexedDB에 저장하기 전에 모든 children 배열 정규화 (재귀적)
      const normalizedLists = lists.map(normalizeItem);
      
      debug('saveChanges normalized lists:', JSON.stringify(normalizedLists, null, 2));
      
      // Save to IndexedDB
      const db = await this._openDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction('kv', 'readwrite');
        const store = tx.objectStore('kv');
        const req = store.put(normalizedLists, 'userLists');
        req.onsuccess = () => {
          debug('saveChanges: IndexedDB save successful');
          resolve(true);
        };
        req.onerror = () => {
          console.error('saveChanges: IndexedDB save failed', req.error);
          reject(req.error);
        };
        tx.oncomplete = () => db.close();
      });
      
      // Emit events with the internal state (preserves children)
      this.emit('listsSaved', { lists: this.state.lists });
      this.emit('stateChanged', { type: 'save', lists: this.state.lists });
      
      return true;
    } catch (err) {
      console.error('Failed to save changes:', err);
      throw err;
    }
  },
  
  async _openDB() {
    return new Promise((resolve, reject) => {
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
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  
  // Load lists from storage
  async loadLists() {
    try {
      const db = await this._openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('kv', 'readonly');
        const store = tx.objectStore('kv');
        const req = store.get('userLists');
        req.onsuccess = () => {
          // 로드된 데이터 정규화
          const normalizeList = (list) => {
            if (!Array.isArray(list)) return [];
            return list.map(item => ({
              ...item,
              children: Array.isArray(item.children) 
                ? normalizeList(item.children)
                : []
            }));
          };
          
          this.state.lists = normalizeList(req.result);
          resolve(this.state.lists);
        };
        req.onerror = () => reject(req.error);
        tx.oncomplete = () => db.close();
      });
    } catch (err) {
      console.error('Failed to load lists:', err);
      this.state.lists = [];
      return this.state.lists;
    }
  },

  // Wait for DOM element with retries
  async waitForElement(selector, timeout = 5000, interval = 50) {
    const start = Date.now();
    
    while (Date.now() - start < timeout) {
      const element = document.querySelector(selector);
      if (element?.isConnected) {
        return element;
      }
      await new Promise(resolve => setTimeout(resolve, interval));
    }
    
    throw new Error(`Timeout waiting for element: ${selector}`);
  },

  // Ensure root element exists and is connected
  async ensureRoot() {
    try {
      // Try to find existing root first with increased timeout
      this.root = await this.waitForElement('#userLists', 5000);
      
      // Verify root is properly connected and structured
      if (!this.root.isConnected) {
        debug('Root found but not connected');
        throw new Error('Root element not connected');
      }
      
      // Ensure root has correct class
      if (!this.root.classList.contains('user-lists')) {
        this.root.className = 'user-lists';
      }
      
      debug('Root element verified');
      return true;
    } catch (e) {
      debug('Creating root element');
      this.root = document.createElement('ul');
      this.root.id = 'userLists';
      this.root.className = 'user-lists';
      
      // Try body first, fallback to documentElement
      const parent = document.body || document.documentElement;
      parent.appendChild(this.root);
      
      // Double-check connection and wait for render cycle
      await new Promise(resolve => {
        const observer = new MutationObserver(() => {
          if (this.root.isConnected) {
            observer.disconnect();
            resolve();
          }
        });
        observer.observe(parent, { childList: true });
        
        // Fallback timeout
        setTimeout(() => {
          observer.disconnect();
          resolve();
        }, 1000);
      });
      
      if (!this.root.isConnected) {
        debug('Failed to connect root element');
        return false;
      }
      
      debug('Root element created and connected');
      return true;
    }
  },

  // Initialize the component
  async init() {
    try {
      if (this.initialized) {
        debug('Already initialized');
        return this;
      }

      debug('Starting initialization');

      // Ensure global state exists
      if (!window.state || !Array.isArray(window.state.userLists)) {
        window.state = { userLists: [] };
      }

      // Ensure DOM is ready
      if (document.readyState === 'loading') {
        await new Promise(resolve => {
          document.addEventListener('DOMContentLoaded', resolve, { once: true });
        });
      }
      
      // Multiple attempts to ensure root with backoff
      let attempts = 0;
      while (attempts < 3) {
        if (await this.ensureRoot()) break;
        await new Promise(r => setTimeout(r, Math.pow(2, attempts) * 100));
        attempts++;
      }

      if (!this.root?.isConnected) {
        throw new Error('Root element initialization failed after retries');
      }

      // Initial render with verification
      await this.render();
      
      // Verify render completed
      if (!document.querySelector('#userLists > .user-list-item, #userLists:empty')) {
        throw new Error('Initial render failed verification');
      }

      // Add event listeners
      this.attachEventListeners();

      // Mark as initialized
      this.initialized = true;
      
      // Signal ready
      document.dispatchEvent(new CustomEvent('paperscout:ready'));
      debug('Initialization complete');

      return this;
    } catch (error) {
      debug('Initialization failed:', error);
      this.initialized = false;
      throw error;
    }
  },

  // Event listener management
  attachEventListeners() {
    if (!this.root?.isConnected) {
      debug('Cannot attach events - root not connected');
      return;
    }

    // Remove existing listeners
    this.removeEventListeners();

    const handlers = {
      dragstart: this.handleDragStart.bind(this),
      dragover: this.handleDragOver.bind(this),
      drop: this.handleDrop.bind(this)
    };

    // Store for cleanup
    this.eventMap.set(this.root, handlers);

    // Add listeners - drag/drop disabled to avoid conflicts with app.js handlers
    // this.root.addEventListener('dragstart', handlers.dragstart, true);
    // this.root.addEventListener('dragover', handlers.dragover, true);
    // this.root.addEventListener('drop', handlers.drop, true);

    debug('Event listeners attached (drag/drop disabled)');
  },

  removeEventListeners() {
    if (this.root && this.eventMap.has(this.root)) {
      const handlers = this.eventMap.get(this.root);
      // this.root.removeEventListener('dragstart', handlers.dragstart, true);
      // this.root.removeEventListener('dragover', handlers.dragover, true);
      // this.root.removeEventListener('drop', handlers.drop, true);
      this.eventMap.delete(this.root);
    }
  },

  handleDragStart(event) {
    debug('handleDragStart called');
    try {
      // 유효성 검사
      if (!event?.target || !event?.dataTransfer) {
        debug('Invalid event or dataTransfer');
        event.preventDefault();
        return false;
      }

      // 드래그할 아이템 찾기
      const target = event.target.closest('.user-list-item[data-id]');
      debug('Drag target found:', target);
      if (!target?.dataset?.id) {
        debug('No valid drag target');
        event.preventDefault();
        return false;
      }

      const id = target.dataset.id;
      debug('Dragging item with id:', id);
      const item = findNode(id, window.state.userLists);
      debug('Item found:', item);
      
      if (!item) {
        debug('Dragged item not found:', id);
        event.preventDefault();
        return false;
      }

      // 데이터 전송 설정
      this.draggedItem = item; // 참조 저장
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.dropEffect = 'move';
      
      // 필수 데이터 설정
      event.dataTransfer.setData('text/x-list-id', id);
      event.dataTransfer.setData('text/plain', id);
      
      // 시각적 피드백
      target.classList.add('dragging');
      debug('Drag started:', { id, item });
      
      return true;
    } catch (err) {
      debug('Drag start error:', err);
      event.preventDefault();
      this.draggedItem = null;
      return false;
    }
  },

  handleDragOver(event) {
    debug('handleDragOver called');
    try {
      if (!event?.target || !event?.dataTransfer) return false;
      
      const target = event.target.closest('.user-list-item[data-id], #userLists, .user-lists--nested');
      debug('Drag over target:', target);
      if (!target || !this.root.contains(target)) return false;

      const types = Array.from(event.dataTransfer.types || []);
      debug('Data transfer types:', types);
      if (types.includes('text/x-list-id') ||
          types.includes('application/x-paperscout-result') ||
          types.includes('Files')) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        
        // Remove drag-over from all elements
        document.querySelectorAll('.drag-over').forEach(el => 
          el.classList.remove('drag-over')
        );
        
        // Add drag-over to current target
        if (target.classList.contains('user-list-item')) {
          target.classList.add('drag-over');
        }
        
        debug('Drag over accepted');
        return true;
      }
      debug('Drag over rejected');
      return false;
    } catch (err) {
      debug('Drag over error:', err);
      return false;
    }
  },

  async handleDrop(event) {
    debug('handleDrop called');
    try {
      event.preventDefault();
      event.stopPropagation();

      // Clean up drag visuals
      document.querySelectorAll('.dragging').forEach(el => 
        el.classList.remove('dragging')
      );
      document.querySelectorAll('.drag-over').forEach(el => 
        el.classList.remove('drag-over')
      );

      const target = event.target.closest('.user-list-item[data-id], #userLists, .user-lists--nested');
      debug('Drop target:', target);
      if (!target || !this.root.contains(target)) {
        debug('Invalid drop target');
        return false;
      }

      // Enhanced duplicate event detection using event properties hash
      const eventHash = `${event.timeStamp}-${event.clientX}-${event.clientY}`;
      if (this.lastEventId === eventHash) {
        debug('Duplicate drop ignored');
        return true;
      }
      this.lastEventId = eventHash;

      let item = null;
      const types = Array.from(event.dataTransfer?.types || []);
      debug('Drop data transfer types:', types);

      if (types.includes('text/x-list-id')) {
        const id = event.dataTransfer.getData('text/x-list-id');
        debug('Moving existing item with id:', id);
        item = findNode(id, window.state.userLists);
        if (item) {
          debug('Moving existing item:', id);
        }
      }
      else if (types.includes('application/x-paperscout-result')) {
        try {
          const data = JSON.parse(event.dataTransfer.getData('application/x-paperscout-result'));
          item = {
            id: crypto.randomUUID(),
            name: data.title || 'Untitled',
            type: 'pdf',
            remoteUrl: data.url,
            children: []
          };
          debug('Creating from search result');
        } catch (err) {
          debug('Invalid search result:', err);
        }
      }
      else if (types.includes('Files') && event.dataTransfer.files.length > 0) {
        const file = event.dataTransfer.files[0];
        if (file && (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'))) {
          item = {
            id: crypto.randomUUID(),
            name: file.name,
            type: 'pdf',
            size: file.size,
            children: []
          };
          debug('Creating from file drop');
        }
      }

      if (!item) {
        debug('No valid item to add');
        return false;
      }

      // Get target list
      let targetList = window.state.userLists;
      if (targetList.length === 0) {
        targetList.push({
          id: crypto.randomUUID(),
          name: 'Files',
          children: []
        });
      }

      const parentEl = target.closest('.user-list-item[data-id]');
      if (parentEl?.dataset?.id) {
        const parent = findNode(parentEl.dataset.id, window.state.userLists);
        if (parent) {
          parent.children = parent.children || [];
          targetList = parent.children;
        }
      }

      // 적절한 위치에 아이템 삽입 및 상태 저장
      try {
        const parentId = parentEl?.dataset?.id || null;
        debug('Drop target parentId:', parentId);

        // If the item already exists in the lists, perform a move.
        const exists = !!findNode(item.id, window.state.userLists);
        if (exists) {
          debug('Existing item detected - moving:', item.id);
          await this.moveNode(window.state.userLists, item.id, parentId, targetList.length, { save: true });

          this.draggedItem = null;
          debug('Item moved and saved:', { itemId: item.id, parentId });

          // UI 갱신
          if (window.renderSidebar) {
            await window.renderSidebar();
          } else {
            await this.render();
          }

          // 이벤트 발생 (move)
          this.emit('nodeMoved', { 
            node: item,
            toParentId: parentId,
            newIndex: targetList.length 
          });
          debug('Drop move operation completed successfully');
        } else {
          // New item: insert instead of move
          debug('New item detected - inserting:', item.id);

          // Use addNodeWithDupCheck to respect duplicate rules if available
          if (typeof this.addNodeWithDupCheck === 'function') {
            await this.addNodeWithDupCheck(window.state.userLists, parentId, item, { save: true });
          } else {
            await this.insertAtIndex(window.state.userLists, parentId, targetList.length, item, { save: true });
          }

          this.draggedItem = null;
          debug('Item inserted and saved:', { itemId: item.id, parentId });

          // UI 갱신
          if (window.renderSidebar) {
            await window.renderSidebar();
          } else {
            await this.render();
          }

          // 이벤트 발생 (insert)
          this.emit('nodeInserted', { node: item, parentId, index: targetList.length });
          this.emit('stateChanged', { type: 'insert', node: item, parentId, index: targetList.length, lists: window.state.userLists });
          debug('Drop insert operation completed successfully');
        }
      } catch (error) {
        console.error('Failed to move/insert item during drop:', error);
        debug('Move/Insert operation failed:', error);
      }

      return true;
    } catch (err) {
      debug('Drop error:', err);
      return false;
    }
  },

  // Enable drag and drop for a specific container
  enableDragAndDrop(container) {
    debug('enableDragAndDrop called with container:', container);
    if (!container) {
      debug('No container provided for drag and drop');
      return;
    }

    const handlers = {
      dragstart: this.handleDragStart.bind(this),
      dragover: this.handleDragOver.bind(this),
      drop: this.handleDrop.bind(this),
      dragend: this.handleDragEnd.bind(this)
    };

    // Remove existing listeners if any
    container.removeEventListener('dragstart', handlers.dragstart, true);
    container.removeEventListener('dragover', handlers.dragover, true);
    container.removeEventListener('drop', handlers.drop, true);
    container.removeEventListener('dragend', handlers.dragend, true);

    // Add listeners
    container.addEventListener('dragstart', handlers.dragstart, true);
    container.addEventListener('dragover', handlers.dragover, true);
    container.addEventListener('drop', handlers.drop, true);
    container.addEventListener('dragend', handlers.dragend, true);

    debug('Drag and drop enabled for container:', container.id || container.className);
  },

  handleDragEnd(event) {
    // Clean up drag visuals
    document.querySelectorAll('.dragging').forEach(el => 
      el.classList.remove('dragging')
    );
    document.querySelectorAll('.drag-over').forEach(el => 
      el.classList.remove('drag-over')
    );
    this.draggedItem = null;
    debug('Drag ended');
  },

  async render() {
    // search-results 페이지에서는 renderSidebar 함수를 사용하므로 ListCore의 render는 사용하지 않음
    if (window.location.pathname.includes('search-results')) {
      debug('ListCore render skipped for search-results page');
      return;
    }

    if (this._rendering) {
      debug('Render already in progress');
      return;
    }

    this._rendering = true;
    debug('Rendering started');

    try {
      if (!this.root?.isConnected) {
        await this.ensureRoot();
      }

      // Clear existing content
      while (this.root.firstChild) {
        this.root.removeChild(this.root.firstChild);
      }

      // Create new content
      const fragment = document.createDocumentFragment();
      for (const list of window.state.userLists) {
        const el = createListItem(list);
        if (el) fragment.appendChild(el);
      }
      
      this.root.appendChild(fragment);

      // Extended verification of render completion
      await new Promise((resolve, reject) => {
        let retries = 0;
        const verify = () => {
          if (retries++ > 10) {
            reject(new Error('Render verification timeout'));
            return;
          }

          const hasContent = document.querySelector('#userLists > .user-list-item, #userLists:empty');
          if (hasContent) {
            resolve();
          } else {
            requestAnimationFrame(verify);
          }
        };
        requestAnimationFrame(verify);
      });

      debug('Render complete');
    } catch (err) {
      debug('Render error:', err);
      throw err;
    } finally {
      this._rendering = false;
    }
  }
};

// Setup render function required by smoke-test.js
window.renderSidebar = async function() {
  debug('window.renderSidebar called');
  // search-results 페이지에서는 search-results.js의 renderSidebar 함수가 우선
  if (window.location.pathname.includes('search-results')) {
    debug('Delegating to search-results.js renderSidebar');
    return;
  }
  
  try {
    if (!window.ListCore?.initialized) {
      await window.ListCore.init();
    }
    await window.ListCore.render();
    
    // Extended verification of render completion
    await new Promise((resolve) => {
      let attempts = 0;
      const checkRender = () => {
        const hasContent = document.querySelector('#userLists > .user-list-item, #userLists:empty');
        if (hasContent || attempts++ > 10) {
          resolve();
        } else {
          requestAnimationFrame(checkRender);
        }
      };
      requestAnimationFrame(checkRender);
    });
    
    debug('renderSidebar complete');
  } catch (err) {
    debug('renderSidebar error:', err);
    throw err;
  }
};