/* Optional server-backed storage for public deployments.
   The API owns authentication, validation, batching, and database credentials.
*/
(function () {
  const baseUrl = String(window.PRICEFLOW_STORAGE_API_URL || '').replace(/\/+$/, '');
  const apiKey = String(window.PRICEFLOW_STORAGE_API_KEY || '');

  function configured() {
    return Boolean(baseUrl);
  }

  function headers(extra) {
    const result = { ...(extra || {}) };
    if (apiKey) result.Authorization = `Bearer ${apiKey}`;
    return result;
  }

  async function request(path, options) {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: headers(options && options.headers)
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Storage API ${response.status}${detail ? `: ${detail.slice(0, 160)}` : ''}`);
    }
    return response;
  }

  window.priceflowStorage = {
    configured,
    async getBackendCount() {
      const response = await request('/backend/count');
      const data = await response.json();
      return Number(data.count) || 0;
    },
    async uploadBackend(file) {
      const response = await request('/backend/import', {
        method: 'POST',
        body: file,
        headers: {
          'Content-Type': file.type || 'text/csv',
          'X-Filename': file.name
        }
      });
      return response.json();
    },
    async downloadBackend() {
      const response = await request('/backend/export');
      const text = await response.text();
      // Repair files uploaded by the older exporter that stored literal "\\n" text.
      return new Blob([text.replaceAll('\\\\n', '\n')], { type: 'text/csv;charset=utf-8' });
    },
    async getPriceHistory() {
      const response = await request('/price-history');
      const data = await response.json();
      return Array.isArray(data.snapshots) ? data.snapshots : [];
    },
    async savePriceHistory(snapshot) {
      const response = await request('/price-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(snapshot)
      });
      return response.json();
    }
  };
})();
