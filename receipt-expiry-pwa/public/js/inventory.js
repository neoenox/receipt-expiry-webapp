const SORTS = new Set(['expiry', 'name', 'createdAt', 'storage']);

export function filterAndSortItems(items, { filter = 'all', search = '', sort = 'expiry' } = {}) {
  const keyword = String(search || '').trim().toLowerCase();
  const filtered = (items || []).filter((item) => {
    if (filter !== 'all' && item.storage !== filter) return false;
    if (!keyword) return true;
    return `${item.name || ''} ${item.quantity || ''}`.toLowerCase().includes(keyword);
  });

  const order = SORTS.has(sort) ? sort : 'expiry';
  return filtered.slice().sort((a, b) => {
    if (order === 'name') {
      const aName = String(a.name || '');
      const bName = String(b.name || '');
      return aName < bName ? -1 : (aName > bName ? 1 : 0);
    }
    if (order === 'createdAt') return (b.createdAt || 0) - (a.createdAt || 0);
    if (order === 'storage') {
      const byStorage = String(a.storage || '').localeCompare(String(b.storage || ''));
      return byStorage || String(a.expiryDate || '').localeCompare(String(b.expiryDate || ''));
    }
    return String(a.expiryDate || '').localeCompare(String(b.expiryDate || ''))
      || (a.createdAt || 0) - (b.createdAt || 0);
  });
}
