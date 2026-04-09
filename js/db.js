// ===== Pinboard IndexedDB Layer =====
const PinboardDB = (() => {
  const DB_NAME = 'PinboardDB';
  const DB_VERSION = 1;
  const STORE = 'entries';

  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('date', 'date');
          store.createIndex('location', 'location');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function getStore(mode = 'readonly') {
    const db = await open();
    const tx = db.transaction(STORE, mode);
    return tx.objectStore(STORE);
  }

  function sortDate(entry) {
    // Trips sort by their start date
    if (entry.type === 'trip') return entry.dateFrom || entry.date;
    return entry.date;
  }

  return {
    async save(entry) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(entry);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },

    async getAll() {
      const store = await getStore();
      return new Promise((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => {
          const entries = req.result.sort((a, b) => {
            const da = sortDate(a) + 'T' + (a.time || '00:00');
            const db2 = sortDate(b) + 'T' + (b.time || '00:00');
            return new Date(db2) - new Date(da);
          });
          resolve(entries);
        };
        req.onerror = () => reject(req.error);
      });
    },

    async get(id) {
      const store = await getStore();
      return new Promise((resolve, reject) => {
        const req = store.get(id);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    },

    async remove(id) {
      const db = await open();
      // Also remove sub-entries if this is a trip
      const all = await this.getAll();
      const toDelete = [id, ...all.filter(e => e.parentTrip === id).map(e => e.id)];

      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        toDelete.forEach(did => store.delete(did));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },

    async getTrips() {
      const all = await this.getAll();
      return all.filter(e => e.type === 'trip');
    },

    async getSubEntries(tripId) {
      const all = await this.getAll();
      return all.filter(e => e.parentTrip === tripId).sort((a, b) =>
        new Date(a.date + 'T' + (a.time || '00:00')) - new Date(b.date + 'T' + (b.time || '00:00'))
      );
    },

    async search({ keyword, tags, dateFrom, dateTo, person, location }) {
      const all = await this.getAll();
      return all.filter(entry => {
        if (keyword) {
          const kw = keyword.toLowerCase();
          const inText = (entry.text || '').toLowerCase().includes(kw);
          const inLocation = (entry.location || '').toLowerCase().includes(kw);
          const inPeople = (entry.people || []).some(p => p.toLowerCase().includes(kw));
          const inTags = (entry.tags || []).some(t => t.toLowerCase().includes(kw));
          const inMood = (entry.mood || '').toLowerCase().includes(kw);
          const inTripName = (entry.tripName || '').toLowerCase().includes(kw);
          if (!inText && !inLocation && !inPeople && !inTags && !inMood && !inTripName) return false;
        }
        if (tags && tags.length > 0) {
          if (!tags.some(t => (entry.tags || []).includes(t))) return false;
        }
        // For trips, check if the date range overlaps
        const entryDate = entry.type === 'trip' ? entry.dateFrom : entry.date;
        const entryDateEnd = entry.type === 'trip' ? entry.dateTo : entry.date;
        if (dateFrom && entryDateEnd < dateFrom) return false;
        if (dateTo && entryDate > dateTo) return false;
        if (person) {
          const p = person.toLowerCase();
          if (!(entry.people || []).some(ep => ep.toLowerCase().includes(p))) return false;
        }
        if (location) {
          const loc = location.toLowerCase();
          if (!(entry.location || '').toLowerCase().includes(loc)) return false;
        }
        return true;
      });
    },

    async getAllTags() {
      const all = await this.getAll();
      const tags = new Set();
      all.forEach(e => (e.tags || []).forEach(t => tags.add(t)));
      return [...tags].sort();
    },

    async getAllPeople() {
      const all = await this.getAll();
      const people = new Set();
      all.forEach(e => (e.people || []).forEach(p => people.add(p)));
      return [...people].sort();
    },

    async getEntriesForMonth(year, month) {
      const all = await this.getAll();
      return all.filter(e => {
        if (e.type === 'trip') {
          // Trip spans across the month
          const from = new Date(e.dateFrom);
          const to = new Date(e.dateTo);
          const monthStart = new Date(year, month, 1);
          const monthEnd = new Date(year, month + 1, 0);
          return from <= monthEnd && to >= monthStart;
        }
        const d = new Date(e.date);
        return d.getFullYear() === year && d.getMonth() === month;
      });
    }
  };
})();
