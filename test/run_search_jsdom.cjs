const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const fetch = require('node-fetch');

async function run() {
  const searchJsPath = path.join(__dirname, '..', 'public', 'search-results.js');
  let code = fs.readFileSync(searchJsPath, 'utf8');

  // Prevent initSidebar (which uses IndexedDB and other browser-only APIs)
  code = code.replace(/await initSidebar\(\);/, "// initSidebar skipped in headless test");

  const html = `<!doctype html><html><head></head><body>
    <div id="resultsSection"></div>
    <ul id="resultsList" class="results__list"></ul>
    <div id="resultsMeta"></div>
    <div id="pagination"></div>
    <div id="empty"></div>
    <div id="loadingIndicator" style="display:none"></div>
    <template id="resultItemTemplate">
      <li class="result-item">
        <a class="result-card__link" data-field="url"></a>
        <div class="result-title" data-field="title"></div>
        <div class="result-authors" data-field="authors"></div>
        <div class="result-journal" data-field="journal"></div>
      </li>
    </template>
    <script id="app">${code}</script>
  </body></html>`;

  const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost:3000/search-results.html?q=cnt' });

  // Provide fetch and console
  dom.window.fetch = (url, opts) => fetch(url, opts);
  dom.window.console = console;

  // Wait for the script to execute and for search to complete (up to timeout)
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Test timed out')), 15000);
    // Poll for results
    (function waitForResults(attempts){
      try {
        const list = dom.window.document.getElementById('resultsList');
        if (list && list.children && list.children.length > 0) {
          clearTimeout(timeout);
          const items = Array.from(list.children).slice(0,10).map(li=>({
            id: li.dataset.id,
            title: li.querySelector('[data-field="title"]')?.textContent || ''
          }));
          console.log('Rendered items count:', list.children.length);
          console.log('Sample rendered titles:', items.map(i=>i.title).slice(0,5));
          return resolve();
        }
      } catch (e) { /* ignore */ }
      if (attempts++ > 70) return reject(new Error('No rendered items'));
      setTimeout(() => waitForResults(attempts), 200);
    })(0);
  });

  console.log('Front-end test completed successfully');
}

run().catch(err => { console.error('Front-end test failed:', err); process.exitCode = 1; });
