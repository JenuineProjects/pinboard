// ===== Pinboard App =====
(() => {
  'use strict';

  // --- State ---
  let currentView = 'highlights';
  let editingId = null;
  let isTrip = false;       // true = creating/editing a trip
  let parentTripId = null;   // set when creating a sub-entry for a trip
  let tempPhotos = [];
  let tempPeople = [];
  let tempTags = [];
  let mapPinData = null; // { lng, lat }
  let fabOpen = false;

  const $ = id => document.getElementById(id);

  // --- Init ---
  document.addEventListener('DOMContentLoaded', () => {
    initServiceWorker();
    initNav();
    initModal();
    initDetailModal();
    initSearch();
    initSettings();
    loadHighlights();
  });

  function initServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  // ===================================================================
  //  UNIFIED ZOOMABLE MAP
  // ===================================================================

  // Ireland bounds for showing county detail
  const IRELAND_BOUNDS = { minLon: -10.7, maxLon: -5.3, minLat: 51.3, maxLat: 55.5 };

  function createZoomableMap(canvas, options = {}) {
    const { onPinClick, onMapClick, isModal } = options;

    // Viewport state
    let centerLng = 0;
    let centerLat = 30;
    let zoom = 1;        // 1 = whole world visible
    const MIN_ZOOM = 1;
    const MAX_ZOOM = 40;

    let pins = [];
    let hoveredFeature = null;
    let mouseX = -1, mouseY = -1;

    // Pan state
    let isDragging = false;
    let dragStartX, dragStartY;
    let dragStartLng, dragStartLat;

    // Pinch zoom state
    let lastPinchDist = 0;

    // Canvas sizing
    function getSize() {
      const parent = canvas.parentElement;
      const w = parent.clientWidth || 560;
      const h = isModal ? 300 : Math.round(w * 0.5);
      return { w, h };
    }

    function setupCanvas() {
      const { w, h } = getSize();
      const dpr = window.devicePixelRatio || 1;
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      return { w, h, dpr };
    }

    // Projection: lng/lat -> pixel
    function lngLatToPixel(lng, lat) {
      const { w, h } = getSize();
      const scale = zoom;
      const x = w / 2 + (lng - centerLng) * (w / 360) * scale;
      const y = h / 2 - (lat - centerLat) * (h / 180) * scale;
      return [x, y];
    }

    // Pixel -> lng/lat
    function pixelToLngLat(px, py) {
      const { w, h } = getSize();
      const scale = zoom;
      const lng = centerLng + (px - w / 2) / ((w / 360) * scale);
      const lat = centerLat - (py - h / 2) / ((h / 180) * scale);
      return [lng, lat];
    }

    // Should we show Ireland county detail?
    function showIrelandDetail() {
      return zoom >= 6;
    }

    // Is a bounding box visible in the current viewport?
    function isFeatureVisible(feature) {
      const { w, h } = getSize();
      const geom = feature.geometry;
      const coords = geom.type === 'Polygon' ? [geom.coordinates] :
                     geom.type === 'MultiPolygon' ? geom.coordinates : [];

      // Quick check: test any coord in polygon
      for (const polygon of coords) {
        for (const ring of polygon) {
          // Sample a few points
          for (let i = 0; i < ring.length; i += Math.max(1, Math.floor(ring.length / 10))) {
            const [px, py] = lngLatToPixel(ring[i][0], ring[i][1]);
            if (px >= -100 && px <= w + 100 && py >= -100 && py <= h + 100) return true;
          }
        }
      }
      return false;
    }

    // --- Drawing ---
    function render() {
      const { w, h, dpr } = setupCanvas();
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);

      // Ocean background
      ctx.fillStyle = '#1e1e34';
      ctx.fillRect(0, 0, w, h);

      // Draw world countries
      const worldData = GEO_DATA.world;
      if (worldData) {
        // When zoomed into Ireland, skip drawing Ireland from world data (we'll draw counties instead)
        const skipIreland = showIrelandDetail();
        worldData.features.forEach(feature => {
          if (skipIreland && feature.properties.name === 'Ireland') return;
          if (!isFeatureVisible(feature)) return;
          const highlighted = hoveredFeature === feature.properties.name;
          drawFeature(ctx, feature, highlighted);
        });
      }

      // Draw Ireland counties when zoomed in
      if (showIrelandDetail() && GEO_DATA.ireland) {
        GEO_DATA.ireland.features.forEach(feature => {
          if (!isFeatureVisible(feature)) return;
          const highlighted = hoveredFeature === feature.properties.name;
          drawFeature(ctx, feature, highlighted, true);
        });
      }

      // Draw pins
      pins.forEach(pin => {
        const [px, py] = lngLatToPixel(pin.lng, pin.lat);
        if (px < -20 || px > w + 20 || py < -20 || py > h + 20) return;

        const pinSize = Math.min(8, 4 + zoom * 0.5);
        // Shadow
        ctx.beginPath();
        ctx.arc(px, py + 2, pinSize, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.fill();
        // Outer circle
        ctx.beginPath();
        ctx.arc(px, py, pinSize, 0, Math.PI * 2);
        ctx.fillStyle = '#f0a500';
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();
        // Inner dot
        ctx.beginPath();
        ctx.arc(px, py, pinSize * 0.4, 0, Math.PI * 2);
        ctx.fillStyle = '#1a1a2e';
        ctx.fill();
      });

      // Tooltip
      if (hoveredFeature && mouseX >= 0) {
        const text = hoveredFeature;
        ctx.font = '13px -apple-system, BlinkMacSystemFont, sans-serif';
        const tm = ctx.measureText(text);
        const tx = Math.min(mouseX + 12, w - tm.width - 16);
        const ty = Math.max(mouseY - 10, 20);
        const rx = tx - 6, ry = ty - 14, rw = tm.width + 12, rh = 22, rr = 6;
        ctx.fillStyle = '#25253e';
        ctx.strokeStyle = '#f0a500';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(rx + rr, ry);
        ctx.lineTo(rx + rw - rr, ry);
        ctx.arcTo(rx + rw, ry, rx + rw, ry + rr, rr);
        ctx.lineTo(rx + rw, ry + rh - rr);
        ctx.arcTo(rx + rw, ry + rh, rx + rw - rr, ry + rh, rr);
        ctx.lineTo(rx + rr, ry + rh);
        ctx.arcTo(rx, ry + rh, rx, ry + rh - rr, rr);
        ctx.lineTo(rx, ry + rr);
        ctx.arcTo(rx, ry, rx + rr, ry, rr);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#e8e8f0';
        ctx.fillText(text, tx, ty);
      }
    }

    function drawFeature(ctx, feature, highlighted, isCounty) {
      const geom = feature.geometry;
      const coords = geom.type === 'Polygon' ? [geom.coordinates] :
                     geom.type === 'MultiPolygon' ? geom.coordinates : [];

      ctx.fillStyle = highlighted ? '#3d3d6a' : (isCounty ? '#35355a' : '#2d2d4a');
      ctx.strokeStyle = highlighted ? '#f0a500' : (isCounty ? '#5a5a8a' : '#4a4a6a');
      ctx.lineWidth = highlighted ? 1.5 : (isCounty ? 0.8 : 0.5);

      coords.forEach(polygon => {
        polygon.forEach(ring => {
          ctx.beginPath();
          let started = false;
          ring.forEach(coord => {
            const [x, y] = lngLatToPixel(coord[0], coord[1]);
            if (!started) { ctx.moveTo(x, y); started = true; }
            else ctx.lineTo(x, y);
          });
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        });
      });
    }

    // --- Hit testing ---
    function hitTestPoint(lng, lat) {
      // Check Ireland counties first if zoomed in
      if (showIrelandDetail() && GEO_DATA.ireland) {
        for (const feature of GEO_DATA.ireland.features) {
          if (pointInFeature(lng, lat, feature)) return feature.properties.name;
        }
      }
      // Then world countries
      if (GEO_DATA.world) {
        for (const feature of GEO_DATA.world.features) {
          if (pointInFeature(lng, lat, feature)) return feature.properties.name;
        }
      }
      return null;
    }

    function pointInFeature(lng, lat, feature) {
      const geom = feature.geometry;
      const polygons = geom.type === 'Polygon' ? [geom.coordinates] :
                       geom.type === 'MultiPolygon' ? geom.coordinates : [];
      for (const polygon of polygons) {
        for (const ring of polygon) {
          if (pointInPolygon(lng, lat, ring)) return true;
        }
      }
      return false;
    }

    function pointInPolygon(x, y, ring) {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], yi = ring[i][1];
        const xj = ring[j][0], yj = ring[j][1];
        if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
          inside = !inside;
        }
      }
      return inside;
    }

    // --- Mouse/touch events ---
    function getPos(e) {
      const rect = canvas.getBoundingClientRect();
      const { w, h } = getSize();
      const scaleX = w / rect.width;
      const scaleY = h / rect.height;
      const cx = e.clientX != null ? e.clientX : e.changedTouches[0].clientX;
      const cy = e.clientY != null ? e.clientY : e.changedTouches[0].clientY;
      return { px: (cx - rect.left) * scaleX, py: (cy - rect.top) * scaleY };
    }

    canvas.addEventListener('mousedown', e => {
      isDragging = true;
      const { px, py } = getPos(e);
      dragStartX = px;
      dragStartY = py;
      dragStartLng = centerLng;
      dragStartLat = centerLat;
    });

    canvas.addEventListener('mousemove', e => {
      const { px, py } = getPos(e);

      if (isDragging) {
        const { w, h } = getSize();
        const dLng = (dragStartX - px) / ((w / 360) * zoom);
        const dLat = (py - dragStartY) / ((h / 180) * zoom);
        centerLng = dragStartLng + dLng;
        centerLat = dragStartLat + dLat;
        render();
        return;
      }

      mouseX = px;
      mouseY = py;
      const [lng, lat] = pixelToLngLat(px, py);
      const name = hitTestPoint(lng, lat);
      if (name !== hoveredFeature) {
        hoveredFeature = name;
        canvas.style.cursor = name ? 'pointer' : (onMapClick ? 'crosshair' : 'grab');
        render();
      }
    });

    canvas.addEventListener('mouseup', e => {
      if (isDragging) {
        const { px, py } = getPos(e);
        const moved = Math.abs(px - dragStartX) + Math.abs(py - dragStartY);
        isDragging = false;

        // If barely moved, treat as click
        if (moved < 5) {
          handleClick(px, py);
        }
      }
    });

    canvas.addEventListener('mouseleave', () => {
      isDragging = false;
      hoveredFeature = null;
      mouseX = -1;
      render();
    });

    // Scroll zoom
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const { px, py } = getPos(e);
      const [lngBefore, latBefore] = pixelToLngLat(px, py);

      const delta = e.deltaY > 0 ? 0.85 : 1.18;
      zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * delta));

      // Keep the point under the mouse fixed
      const [lngAfter, latAfter] = pixelToLngLat(px, py);
      centerLng -= (lngAfter - lngBefore);
      centerLat -= (latAfter - latBefore);

      render();
    }, { passive: false });

    // Touch: pan + pinch zoom
    canvas.addEventListener('touchstart', e => {
      if (e.touches.length === 1) {
        isDragging = true;
        const rect = canvas.getBoundingClientRect();
        const { w, h } = getSize();
        const scaleX = w / rect.width;
        const scaleY = h / rect.height;
        dragStartX = (e.touches[0].clientX - rect.left) * scaleX;
        dragStartY = (e.touches[0].clientY - rect.top) * scaleY;
        dragStartLng = centerLng;
        dragStartLat = centerLat;
      } else if (e.touches.length === 2) {
        isDragging = false;
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        lastPinchDist = Math.sqrt(dx * dx + dy * dy);
      }
    }, { passive: true });

    canvas.addEventListener('touchmove', e => {
      e.preventDefault();
      if (e.touches.length === 1 && isDragging) {
        const rect = canvas.getBoundingClientRect();
        const { w, h } = getSize();
        const scaleX = w / rect.width;
        const scaleY = h / rect.height;
        const px = (e.touches[0].clientX - rect.left) * scaleX;
        const py = (e.touches[0].clientY - rect.top) * scaleY;
        const dLng = (dragStartX - px) / ((w / 360) * zoom);
        const dLat = (py - dragStartY) / ((h / 180) * zoom);
        centerLng = dragStartLng + dLng;
        centerLat = dragStartLat + dLat;
        render();
      } else if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (lastPinchDist > 0) {
          const scale = dist / lastPinchDist;
          zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * scale));
          render();
        }
        lastPinchDist = dist;
      }
    }, { passive: false });

    canvas.addEventListener('touchend', e => {
      if (e.touches.length === 0 && isDragging) {
        const { px, py } = getPos(e);
        const moved = Math.abs(px - dragStartX) + Math.abs(py - dragStartY);
        isDragging = false;
        if (moved < 10) {
          handleClick(px, py);
        }
      }
      lastPinchDist = 0;
    });

    function handleClick(px, py) {
      const [lng, lat] = pixelToLngLat(px, py);
      const { w, h } = getSize();

      // Check pin clicks
      if (onPinClick && pins.length) {
        for (const pin of pins) {
          const [pinPx, pinPy] = lngLatToPixel(pin.lng, pin.lat);
          const dist = Math.sqrt((px - pinPx) ** 2 + (py - pinPy) ** 2);
          if (dist < 14) {
            onPinClick(pin);
            return;
          }
        }
      }

      if (onMapClick) {
        const name = hitTestPoint(lng, lat);
        onMapClick(lng, lat, name);
      }
    }

    // --- Public API ---
    return {
      render,
      setPins(newPins) { pins = newPins; render(); },
      setView(lng, lat, z) { centerLng = lng; centerLat = lat; zoom = z; render(); },
      zoomIn() { zoom = Math.min(MAX_ZOOM, zoom * 1.5); render(); },
      zoomOut() { zoom = Math.max(MIN_ZOOM, zoom / 1.5); render(); },
      resetView() { centerLng = 0; centerLat = 30; zoom = 1; render(); },
      focusIreland() { centerLng = -8; centerLat = 53.5; zoom = 12; render(); },
      getZoom() { return zoom; }
    };
  }

  // ===================================================================
  //  NAVIGATION
  // ===================================================================
  function initNav() {
    document.querySelectorAll('.nav-item').forEach(btn => {
      btn.addEventListener('click', () => switchView(btn.dataset.view));
    });
    $('searchToggle').addEventListener('click', () => switchView('search'));
  }

  function switchView(view) {
    currentView = view;
    document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));

    if (view === 'highlights') {
      $('highlightsView').classList.add('active');
      loadHighlights();
    } else if (view === 'map') {
      $('mapView').classList.add('active');
      initMainMap();
    } else if (view === 'search') {
      $('searchView').classList.add('active');
      loadSearchFilters();
    }
  }

  // ===================================================================
  //  HIGHLIGHTS VIEW
  // ===================================================================
  async function loadHighlights() {
    const allEntries = await PinboardDB.getAll();
    const container = $('highlightsContent');
    const empty = $('highlightsEmpty');

    if (allEntries.length === 0) {
      container.innerHTML = '';
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';

    // Group by month (top-level entries and trips only, not sub-entries)
    const topLevel = allEntries.filter(e => !e.parentTrip);
    const months = {};

    topLevel.forEach(entry => {
      const d = entry.type === 'trip' ? entry.dateFrom : entry.date;
      const key = d.slice(0, 7); // "2026-01"
      if (!months[key]) months[key] = [];
      months[key].push(entry);
    });

    // Sort months newest first
    const sortedMonths = Object.keys(months).sort((a, b) => b.localeCompare(a));

    let html = '';
    for (const monthKey of sortedMonths) {
      const items = months[monthKey];
      const [year, month] = monthKey.split('-');
      const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'];
      const monthName = monthNames[parseInt(month) - 1];

      // Collect all photos from this month (including sub-entries)
      const allPhotos = [];
      const locations = new Set();
      const people = new Set();
      let entryCount = 0;
      let tripCount = 0;

      items.forEach(e => {
        (e.photos || []).forEach(p => allPhotos.push(p));
        if (e.location) locations.add(e.location);
        (e.people || []).forEach(p => people.add(p));
        if (e.type === 'trip') {
          tripCount++;
          // Include sub-entry photos
          const subs = allEntries.filter(s => s.parentTrip === e.id);
          subs.forEach(s => {
            (s.photos || []).forEach(p => allPhotos.push(p));
            if (s.location) locations.add(s.location);
            (s.people || []).forEach(p => people.add(p));
          });
        } else {
          entryCount++;
        }
      });

      // Month header
      html += `<div class="month-section">`;
      html += `<div class="month-header">
        <h2>${monthName}</h2>
        <span class="month-year">${year}</span>
      </div>`;

      // Stats
      const stats = [];
      if (entryCount) stats.push(`<span class="month-stat"><strong>${entryCount}</strong> memor${entryCount === 1 ? 'y' : 'ies'}</span>`);
      if (tripCount) stats.push(`<span class="month-stat"><strong>${tripCount}</strong> trip${tripCount === 1 ? '' : 's'}</span>`);
      if (locations.size) stats.push(`<span class="month-stat"><strong>${locations.size}</strong> place${locations.size === 1 ? '' : 's'}</span>`);
      if (people.size) stats.push(`<span class="month-stat"><strong>${people.size}</strong> ${people.size === 1 ? 'person' : 'people'}</span>`);
      if (stats.length) html += `<div class="month-stats">${stats.join('')}</div>`;

      // Photo mosaic (max 5)
      if (allPhotos.length > 0) {
        const showPhotos = allPhotos.slice(0, 5);
        const countClass = showPhotos.length === 1 ? 'photos-1' :
                          showPhotos.length === 2 ? 'photos-2' :
                          showPhotos.length === 3 ? 'photos-3' :
                          showPhotos.length === 4 ? 'photos-4' : 'photos-many';
        html += `<div class="month-photos ${countClass}">`;
        showPhotos.forEach((p, i) => {
          if (i === 4 && allPhotos.length > 5) {
            html += `<div class="photos-more" data-photo="${p}">
              <img class="mosaic-photo" src="${p}" alt="">
              <span class="photos-more-label">+${allPhotos.length - 4}</span>
            </div>`;
          } else {
            html += `<img class="mosaic-photo" src="${p}" alt="" data-photo="${p}">`;
          }
        });
        html += `</div>`;
      }

      // Highlight items (entries and trips)
      items.sort((a, b) => {
        const da = a.type === 'trip' ? a.dateFrom : a.date;
        const db2 = b.type === 'trip' ? b.dateFrom : b.date;
        return da.localeCompare(db2);
      });

      items.forEach(entry => {
        if (entry.type === 'trip') {
          const thumb = (entry.photos && entry.photos[0]) ? `<img class="highlight-thumb" src="${entry.photos[0]}" alt="">` : '';
          const from = formatDateShort(entry.dateFrom);
          const to = formatDateShort(entry.dateTo);
          const subCount = allEntries.filter(s => s.parentTrip === entry.id).length;
          html += `<div class="highlight-item highlight-trip" data-detail="${entry.id}">
            ${thumb}
            <div class="highlight-info">
              <div class="highlight-title">&#9992; ${escapeHtml(entry.tripName || 'Trip')}</div>
              <div class="highlight-sub">
                <span>${from} &mdash; ${to}</span>
                ${entry.location ? `<span>&#128205; ${escapeHtml(entry.location)}</span>` : ''}
                ${subCount ? `<span>${subCount} entr${subCount === 1 ? 'y' : 'ies'}</span>` : ''}
              </div>
              ${entry.mood ? `<div class="highlight-mood">${escapeHtml(entry.mood)}</div>` : ''}
            </div>
          </div>`;
        } else {
          const thumb = (entry.photos && entry.photos[0]) ? `<img class="highlight-thumb" src="${entry.photos[0]}" alt="">` : '';
          const title = entry.text ? entry.text.split('\n')[0].slice(0, 60) + (entry.text.length > 60 ? '...' : '') : 'Memory';
          const date = formatDateShort(entry.date);
          html += `<div class="highlight-item" data-detail="${entry.id}">
            ${thumb}
            <div class="highlight-info">
              <div class="highlight-title">${escapeHtml(title)}</div>
              <div class="highlight-sub">
                <span class="highlight-date">${date}</span>
                ${entry.location ? `<span>&#128205; ${escapeHtml(entry.location)}</span>` : ''}
                ${entry.people && entry.people.length ? `<span>${entry.people.map(p => escapeHtml(p)).join(', ')}</span>` : ''}
              </div>
              ${entry.mood ? `<div class="highlight-mood">${escapeHtml(entry.mood)}</div>` : ''}
            </div>
          </div>`;
        }
      });

      html += `</div>`; // month-section
    }

    container.innerHTML = html;

    // Attach click listeners
    container.querySelectorAll('.highlight-item').forEach(item => {
      item.addEventListener('click', () => openDetailModal(item.dataset.detail));
    });
    container.querySelectorAll('.mosaic-photo, .photos-more').forEach(img => {
      img.addEventListener('click', () => {
        const src = img.dataset.photo || img.src;
        if (src) {
          $('lightboxImg').src = src;
          $('lightbox').classList.add('active');
        }
      });
    });
  }

  // ===================================================================
  //  DETAIL MODAL (viewing a full entry or trip)
  // ===================================================================
  async function openDetailModal(id) {
    const entry = await PinboardDB.get(id);
    if (!entry) return;

    const content = $('detailContent');

    if (entry.type === 'trip') {
      $('detailTitle').textContent = entry.tripName || 'Trip';
      const subs = await PinboardDB.getSubEntries(id);
      content.innerHTML = renderDetailTrip(entry, subs);
    } else {
      $('detailTitle').textContent = 'Memory';
      content.innerHTML = renderDetailEntry(entry);
    }

    // Attach listeners
    content.querySelectorAll('.entry-photo, .mosaic-photo').forEach(img => {
      img.addEventListener('click', () => {
        $('lightboxImg').src = img.dataset.photo || img.src;
        $('lightbox').classList.add('active');
      });
    });
    content.querySelectorAll('.edit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $('detailModal').classList.remove('active');
        openEditModal(btn.dataset.id);
      });
    });
    content.querySelectorAll('.entry-delete-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (confirm('Delete this memory?')) {
          await PinboardDB.remove(btn.dataset.id);
          $('detailModal').classList.remove('active');
          refreshCurrentView();
        }
      });
    });
    content.querySelectorAll('.add-subentry-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $('detailModal').classList.remove('active');
        openNewSubEntryModal(btn.dataset.tripId);
      });
    });
    content.querySelectorAll('.detail-sub-item').forEach(item => {
      item.addEventListener('click', () => {
        $('detailModal').classList.remove('active');
        openDetailModal(item.dataset.detail);
      });
    });

    $('detailModal').classList.add('active');
  }

  function renderDetailEntry(entry) {
    const photos = (entry.photos || []).map(p =>
      `<img class="entry-photo" src="${p}" alt="Photo" data-photo="${p}">`
    ).join('');

    const meta = [];
    const date = entry.type === 'trip' ? `${formatDate(entry.dateFrom)} &mdash; ${formatDate(entry.dateTo)}` : formatDate(entry.date);
    meta.push(['Date', date + (entry.time ? ` &middot; ${formatTime(entry.time)}` : '')]);
    if (entry.location) meta.push(['Location', `&#128205; ${escapeHtml(entry.location)}`]);
    if (entry.mood) meta.push(['Feeling', escapeHtml(entry.mood)]);
    if (entry.people && entry.people.length) meta.push(['With', entry.people.map(p => escapeHtml(p)).join(', ')]);
    if (entry.tags && entry.tags.length) meta.push(['Tags', entry.tags.map(t => `#${escapeHtml(t)}`).join(' ')]);

    const metaHtml = meta.map(([label, value]) =>
      `<div class="detail-meta-label">${label}</div><div class="detail-meta-value">${value}</div>`
    ).join('');

    return `
      <div class="detail-entry">
        ${photos ? `<div class="entry-photos">${photos}</div>` : ''}
        ${entry.text ? `<div class="entry-text">${escapeHtml(entry.text)}</div>` : ''}
        <div class="detail-meta-grid">${metaHtml}</div>
        <div class="detail-actions">
          <button class="entry-action-btn edit-btn" data-id="${entry.id}">Edit</button>
          <button class="entry-action-btn delete entry-delete-btn" data-id="${entry.id}">Delete</button>
        </div>
      </div>
    `;
  }

  function renderDetailTrip(trip, subEntries) {
    const tripDetail = renderDetailEntry(trip);

    const subsHtml = subEntries.map(e => {
      const thumb = (e.photos && e.photos[0]) ? `<img class="highlight-thumb" src="${e.photos[0]}" alt="">` : '';
      const title = e.text ? e.text.split('\n')[0].slice(0, 50) : 'Memory';
      return `<div class="highlight-item detail-sub-item" data-detail="${e.id}">
        ${thumb}
        <div class="highlight-info">
          <div class="highlight-title">${escapeHtml(title)}</div>
          <div class="highlight-sub">
            <span class="highlight-date">${formatDateShort(e.date)}</span>
            ${e.location ? `<span>&#128205; ${escapeHtml(e.location)}</span>` : ''}
          </div>
        </div>
      </div>`;
    }).join('');

    return `
      ${tripDetail}
      ${subsHtml ? `<div class="detail-subentries"><h4>Memories from this trip</h4>${subsHtml}</div>` : ''}
      <button class="add-subentry-btn" data-trip-id="${trip.id}">+ Add memory to this trip</button>
    `;
  }

  function initDetailModal() {
    $('detailClose').addEventListener('click', () => $('detailModal').classList.remove('active'));
    $('detailModal').addEventListener('click', e => {
      if (e.target === $('detailModal')) $('detailModal').classList.remove('active');
    });
  }

  // ===================================================================
  //  MODAL (New/Edit Entry)
  // ===================================================================
  let modalMap = null;

  function initModal() {
    // FAB menu
    $('fabNew').addEventListener('click', () => {
      fabOpen = !fabOpen;
      $('fabNew').classList.toggle('open', fabOpen);
      $('fabMenu').classList.toggle('open', fabOpen);
    });
    $('fabNewEntry').addEventListener('click', () => { closeFab(); openNewModal(false); });
    $('fabNewTrip').addEventListener('click', () => { closeFab(); openNewModal(true); });

    $('modalClose').addEventListener('click', closeModal);
    $('entryModal').addEventListener('click', e => {
      if (e.target === $('entryModal')) closeModal();
    });

    $('addPhotoBtn').addEventListener('click', () => $('photoInput').click());
    $('photoInput').addEventListener('change', handlePhotoSelect);
    $('gpsBtn').addEventListener('click', detectLocation);

    $('addPersonBtn').addEventListener('click', addPerson);
    $('personInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addPerson(); } });

    $('addTagBtn').addEventListener('click', addTag);
    $('tagInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } });

    // Modal map zoom controls
    $('modalZoomIn').addEventListener('click', e => { e.preventDefault(); if (modalMap) modalMap.zoomIn(); });
    $('modalZoomOut').addEventListener('click', e => { e.preventDefault(); if (modalMap) modalMap.zoomOut(); });
    $('modalZoomReset').addEventListener('click', e => { e.preventDefault(); if (modalMap) modalMap.resetView(); });

    $('saveEntry').addEventListener('click', saveEntry);

    $('lightboxClose').addEventListener('click', () => $('lightbox').classList.remove('active'));
    $('lightbox').addEventListener('click', e => {
      if (e.target === $('lightbox')) $('lightbox').classList.remove('active');
    });
  }

  function closeFab() {
    fabOpen = false;
    $('fabNew').classList.remove('open');
    $('fabMenu').classList.remove('open');
  }

  function initModalMap() {
    const canvas = $('modalMapCanvas');
    const currentPins = mapPinData ? [mapPinData] : [];

    modalMap = createZoomableMap(canvas, {
      isModal: true,
      onMapClick(lng, lat, featureName) {
        mapPinData = { lng, lat };
        modalMap.setPins([mapPinData]);
      }
    });
    modalMap.setPins(currentPins);

    // Start zoomed into Ireland by default
    if (!mapPinData) {
      modalMap.focusIreland();
    } else {
      // Focus on existing pin
      modalMap.setView(mapPinData.lng, mapPinData.lat, 10);
    }
  }

  function openNewModal(tripMode) {
    editingId = null;
    isTrip = !!tripMode;
    parentTripId = null;
    configureModalForMode();
    resetForm();
    const now = new Date();
    if (isTrip) {
      $('tripDateFrom').value = now.toISOString().split('T')[0];
    } else {
      $('entryDate').value = now.toISOString().split('T')[0];
    }
    $('entryModal').classList.add('active');
    setTimeout(() => initModalMap(), 50);
  }

  async function openNewSubEntryModal(tripId) {
    editingId = null;
    isTrip = false;
    parentTripId = tripId;
    configureModalForMode();
    resetForm();

    // Get the trip to constrain dates
    const trip = await PinboardDB.get(tripId);
    if (trip) {
      $('entryDate').min = trip.dateFrom;
      $('entryDate').max = trip.dateTo;
      $('entryDate').value = trip.dateFrom;
      $('modalTitle').textContent = `Add to ${trip.tripName || 'Trip'}`;
    } else {
      $('entryDate').value = new Date().toISOString().split('T')[0];
      $('modalTitle').textContent = 'Add to Trip';
    }

    $('tripSelectGroup').style.display = 'none';
    $('entryModal').classList.add('active');
    setTimeout(() => initModalMap(), 50);
  }

  async function openEditModal(id) {
    const entry = await PinboardDB.get(id);
    if (!entry) return;

    editingId = id;
    isTrip = entry.type === 'trip';
    parentTripId = entry.parentTrip || null;
    configureModalForMode();

    if (isTrip) {
      $('tripName').value = entry.tripName || '';
      $('tripDateFrom').value = entry.dateFrom || '';
      $('tripDateTo').value = entry.dateTo || '';
      $('entryText').value = entry.text || '';
    } else {
      $('entryText').value = entry.text || '';
      $('entryDate').value = entry.date || '';
      $('entryTime').value = entry.time || '';
    }

    $('entryLocation').value = entry.location || '';
    $('entryMood').value = entry.mood || '';

    tempPhotos = (entry.photos || []).map(p => ({ dataUrl: p }));
    renderPhotoPreviews();

    tempPeople = [...(entry.people || [])];
    renderPeople();

    tempTags = [...(entry.tags || [])];
    renderTags();

    mapPinData = entry.mapPin || null;

    $('entryModal').classList.add('active');
    setTimeout(() => initModalMap(), 50);
  }

  function configureModalForMode() {
    if (isTrip) {
      $('modalTitle').textContent = editingId ? 'Edit Trip' : 'New Trip';
      $('saveEntry').textContent = editingId ? 'Update Trip' : 'Create Trip \u{2708}';
      $('tripFields').style.display = 'block';
      $('entryDateRow').style.display = 'none';
      $('tripSelectGroup').style.display = 'none';
      $('textLabel').textContent = 'Trip notes (optional)';
      $('entryText').placeholder = 'Any notes about the trip overall...';
    } else {
      $('modalTitle').textContent = editingId ? 'Edit Memory' : 'New Memory';
      $('saveEntry').textContent = editingId ? 'Update Memory' : 'Pin This Memory \u{1F4CC}';
      $('tripFields').style.display = 'none';
      $('entryDateRow').style.display = 'flex';
      $('tripSelectGroup').style.display = parentTripId ? 'none' : 'block';
      $('textLabel').textContent = 'What happened?';
      $('entryText').placeholder = 'Write about this memory...';
      loadTripSelector();
    }
  }

  async function loadTripSelector() {
    const trips = await PinboardDB.getTrips();
    const select = $('parentTripSelect');
    select.innerHTML = '<option value="">None (standalone entry)</option>' +
      trips.map(t => `<option value="${t.id}">${escapeHtml(t.tripName || 'Trip')} (${formatDate(t.dateFrom)})</option>`).join('');
    if (parentTripId) select.value = parentTripId;
  }

  function closeModal() {
    $('entryModal').classList.remove('active');
    resetForm();
  }

  function resetForm() {
    $('entryText').value = '';
    $('entryDate').value = '';
    $('entryDate').min = '';
    $('entryDate').max = '';
    $('entryTime').value = '';
    $('entryLocation').value = '';
    $('entryMood').value = '';
    $('tripName').value = '';
    $('tripDateFrom').value = '';
    $('tripDateTo').value = '';
    tempPhotos = [];
    tempPeople = [];
    tempTags = [];
    mapPinData = null;
    renderPhotoPreviews();
    renderPeople();
    renderTags();
  }

  // --- Photos ---
  function handlePhotoSelect(e) {
    const files = Array.from(e.target.files);
    files.forEach(file => {
      const reader = new FileReader();
      reader.onload = ev => {
        tempPhotos.push({ dataUrl: ev.target.result });
        renderPhotoPreviews();
      };
      reader.readAsDataURL(file);
    });
    e.target.value = '';
  }

  function renderPhotoPreviews() {
    const area = $('photoArea');
    const existing = area.querySelectorAll('.photo-preview-wrapper');
    existing.forEach(el => el.remove());

    tempPhotos.forEach((photo, i) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'photo-preview-wrapper';
      wrapper.innerHTML = `
        <img class="photo-preview" src="${photo.dataUrl}" alt="Photo">
        <button class="remove-photo" data-index="${i}">&times;</button>
      `;
      area.insertBefore(wrapper, $('addPhotoBtn'));
    });

    area.querySelectorAll('.remove-photo').forEach(btn => {
      btn.addEventListener('click', e => {
        e.preventDefault();
        tempPhotos.splice(parseInt(btn.dataset.index), 1);
        renderPhotoPreviews();
      });
    });
  }

  // --- GPS ---
  function detectLocation() {
    if (!navigator.geolocation) {
      alert('Geolocation is not supported by your browser');
      return;
    }
    const btn = $('gpsBtn');
    btn.classList.add('locating');

    navigator.geolocation.getCurrentPosition(
      async pos => {
        btn.classList.remove('locating');
        const { latitude, longitude } = pos.coords;
        try {
          const resp = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json`);
          const data = await resp.json();
          const parts = [];
          if (data.address) {
            if (data.address.city || data.address.town || data.address.village) {
              parts.push(data.address.city || data.address.town || data.address.village);
            }
            if (data.address.county) parts.push(data.address.county);
            if (data.address.country) parts.push(data.address.country);
          }
          $('entryLocation').value = parts.join(', ') || `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
        } catch {
          $('entryLocation').value = `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
        }

        // Auto-place pin and zoom to it
        mapPinData = { lng: longitude, lat: latitude };
        if (modalMap) {
          modalMap.setPins([mapPinData]);
          modalMap.setView(longitude, latitude, 12);
        }
      },
      () => {
        btn.classList.remove('locating');
        alert('Could not detect your location. You can type it manually.');
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  // --- People ---
  function addPerson() {
    const input = $('personInput');
    const name = input.value.trim();
    if (name && !tempPeople.includes(name)) {
      tempPeople.push(name);
      renderPeople();
    }
    input.value = '';
  }

  function renderPeople() {
    const container = $('peopleContainer');
    container.innerHTML = tempPeople.map((p, i) =>
      `<span class="person-chip">${escapeHtml(p)} <span class="remove-person" data-index="${i}">&times;</span></span>`
    ).join('');
    container.querySelectorAll('.remove-person').forEach(btn => {
      btn.addEventListener('click', () => {
        tempPeople.splice(parseInt(btn.dataset.index), 1);
        renderPeople();
      });
    });
  }

  // --- Tags ---
  function addTag() {
    const input = $('tagInput');
    const tag = input.value.trim().toLowerCase().replace(/^#/, '');
    if (tag && !tempTags.includes(tag)) {
      tempTags.push(tag);
      renderTags();
    }
    input.value = '';
  }

  function renderTags() {
    const container = $('tagsContainer');
    container.innerHTML = tempTags.map((t, i) =>
      `<span class="tag">#${escapeHtml(t)} <span class="remove-tag" data-index="${i}">&times;</span></span>`
    ).join('');
    container.querySelectorAll('.remove-tag').forEach(btn => {
      btn.addEventListener('click', () => {
        tempTags.splice(parseInt(btn.dataset.index), 1);
        renderTags();
      });
    });
  }

  // --- Save Entry ---
  async function saveEntry() {
    const text = $('entryText').value.trim();

    if (isTrip) {
      const tripName = $('tripName').value.trim();
      const dateFrom = $('tripDateFrom').value;
      const dateTo = $('tripDateTo').value;

      if (!tripName) { alert('Please enter a trip name.'); return; }
      if (!dateFrom || !dateTo) { alert('Please select start and end dates.'); return; }
      if (dateTo < dateFrom) { alert('End date must be after start date.'); return; }

      const entry = {
        id: editingId || generateId(),
        type: 'trip',
        tripName,
        dateFrom,
        dateTo,
        date: dateFrom,
        text,
        location: $('entryLocation').value.trim(),
        mood: $('entryMood').value.trim(),
        photos: tempPhotos.map(p => p.dataUrl),
        people: [...tempPeople],
        tags: [...tempTags],
        mapPin: mapPinData,
        createdAt: editingId ? undefined : new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      if (editingId) {
        const existing = await PinboardDB.get(editingId);
        if (existing) entry.createdAt = existing.createdAt;
      }

      await PinboardDB.save(entry);
    } else {
      const date = $('entryDate').value;

      if (!text && tempPhotos.length === 0) {
        alert('Add some text or a photo to save this memory!');
        return;
      }
      if (!date) { alert('Please select a date.'); return; }

      // Check if user selected a parent trip
      const selectedTrip = parentTripId || ($('parentTripSelect') ? $('parentTripSelect').value : '');

      const entry = {
        id: editingId || generateId(),
        type: 'entry',
        text,
        date,
        time: $('entryTime').value || '',
        location: $('entryLocation').value.trim(),
        mood: $('entryMood').value.trim(),
        photos: tempPhotos.map(p => p.dataUrl),
        people: [...tempPeople],
        tags: [...tempTags],
        mapPin: mapPinData,
        parentTrip: selectedTrip || null,
        createdAt: editingId ? undefined : new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      if (editingId) {
        const existing = await PinboardDB.get(editingId);
        if (existing) entry.createdAt = existing.createdAt;
      }

      await PinboardDB.save(entry);
    }

    closeModal();
    refreshCurrentView();
  }

  // ===================================================================
  //  MAIN MAP VIEW
  // ===================================================================
  let mainMap = null;

  async function initMainMap() {
    const canvas = $('mapCanvas');
    const entries = await PinboardDB.getAll();
    const pinned = entries.filter(e => e.mapPin);
    const pins = pinned.map(e => ({ lng: e.mapPin.lng, lat: e.mapPin.lat, entry: e }));

    if (!mainMap) {
      mainMap = createZoomableMap(canvas, {
        onPinClick(pin) {
          showMapEntryDetail(pin.entry);
        }
      });

      // Zoom controls
      $('zoomIn').addEventListener('click', () => mainMap.zoomIn());
      $('zoomOut').addEventListener('click', () => mainMap.zoomOut());
      $('zoomReset').addEventListener('click', () => mainMap.resetView());
    }

    mainMap.setPins(pins);

    const listContainer = $('mapEntries');
    if (pinned.length > 0) {
      listContainer.innerHTML = `<h3>${pinned.length} memor${pinned.length === 1 ? 'y' : 'ies'} pinned</h3>` +
        pinned.map(e => renderHighlightItem(e)).join('');
      attachHighlightListeners(listContainer);
    } else {
      listContainer.innerHTML = `<div class="empty-state"><p>No memories pinned to the map yet.<br>Add a pin when creating a new memory!</p></div>`;
    }
  }

  function showMapEntryDetail(entry) {
    openDetailModal(entry.id);
  }

  // ===================================================================
  //  SEARCH
  // ===================================================================
  function initSearch() {
    let debounceTimer;
    const runSearch = () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(performSearch, 300);
    };

    $('searchInput').addEventListener('input', runSearch);
    $('filterDateFrom').addEventListener('change', runSearch);
    $('filterDateTo').addEventListener('change', runSearch);
    $('filterPerson').addEventListener('input', runSearch);
    $('filterLocation').addEventListener('input', runSearch);

    $('clearFilters').addEventListener('click', () => {
      $('searchInput').value = '';
      $('filterDateFrom').value = '';
      $('filterDateTo').value = '';
      $('filterPerson').value = '';
      $('filterLocation').value = '';
      $('filterTags').querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
      performSearch();
    });
  }

  async function loadSearchFilters() {
    const tags = await PinboardDB.getAllTags();
    const container = $('filterTags');
    container.innerHTML = tags.map(t =>
      `<button class="filter-chip" data-tag="${t}">#${t}</button>`
    ).join('');
    if (tags.length === 0) {
      container.innerHTML = '<span style="color:var(--text-dim);font-size:13px">No tags yet</span>';
    }
    container.querySelectorAll('.filter-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        chip.classList.toggle('active');
        performSearch();
      });
    });
    performSearch();
  }

  async function performSearch() {
    const keyword = $('searchInput').value.trim();
    const activeTags = Array.from($('filterTags').querySelectorAll('.filter-chip.active'))
      .map(c => c.dataset.tag);
    const dateFrom = $('filterDateFrom').value;
    const dateTo = $('filterDateTo').value;
    const person = $('filterPerson').value.trim();
    const location = $('filterLocation').value.trim();

    const results = await PinboardDB.search({
      keyword: keyword || null,
      tags: activeTags.length > 0 ? activeTags : null,
      dateFrom: dateFrom || null,
      dateTo: dateTo || null,
      person: person || null,
      location: location || null
    });

    const info = $('searchResultsInfo');
    const container = $('searchResults');

    if (!keyword && activeTags.length === 0 && !dateFrom && !dateTo && !person && !location) {
      info.textContent = '';
      container.innerHTML = results.map(e => renderHighlightItem(e)).join('') ||
        '<div class="empty-state"><p>No memories yet. Start pinning!</p></div>';
    } else {
      info.textContent = `${results.length} memor${results.length === 1 ? 'y' : 'ies'} found`;
      container.innerHTML = results.map(e => renderHighlightItem(e)).join('') ||
        '<div class="empty-state"><p>No memories match your filters.</p></div>';
    }

    attachHighlightListeners(container);
  }

  // ===================================================================
  //  SETTINGS (Export / Import)
  // ===================================================================
  function initSettings() {
    $('settingsToggle').addEventListener('click', () => {
      const panel = $('settingsPanel');
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    });

    $('exportBtn').addEventListener('click', exportData);
    $('importFile').addEventListener('change', importData);
  }

  async function exportData() {
    const entries = await PinboardDB.getAll();
    const data = {
      app: 'Pinboard',
      version: 1,
      exportDate: new Date().toISOString(),
      entries
    };
    const json = JSON.stringify(data);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pinboard-backup-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function importData(e) {
    const file = e.target.files[0];
    if (!file) return;

    try {
      const text = await file.text();
      const data = JSON.parse(text);

      if (data.app !== 'Pinboard' || !data.entries) {
        alert('This file doesn\'t look like a Pinboard backup.');
        return;
      }

      const count = data.entries.length;
      if (!confirm(`Import ${count} memor${count === 1 ? 'y' : 'ies'}? This will add to your existing data (duplicates will be overwritten).`)) {
        return;
      }

      for (const entry of data.entries) {
        await PinboardDB.save(entry);
      }

      alert(`Imported ${count} memor${count === 1 ? 'y' : 'ies'} successfully!`);
      $('settingsPanel').style.display = 'none';
      refreshCurrentView();
    } catch (err) {
      alert('Error importing file. Make sure it\'s a valid Pinboard backup.');
    }

    e.target.value = '';
  }

  // ===================================================================
  //  SHARED RENDERING HELPERS
  // ===================================================================
  function renderHighlightItem(entry) {
    const thumb = (entry.photos && entry.photos[0]) ? `<img class="highlight-thumb" src="${entry.photos[0]}" alt="">` : '';
    if (entry.type === 'trip') {
      const from = formatDateShort(entry.dateFrom);
      const to = formatDateShort(entry.dateTo);
      return `<div class="highlight-item highlight-trip" data-detail="${entry.id}">
        ${thumb}
        <div class="highlight-info">
          <div class="highlight-title">&#9992; ${escapeHtml(entry.tripName || 'Trip')}</div>
          <div class="highlight-sub">
            <span>${from} &mdash; ${to}</span>
            ${entry.location ? `<span>&#128205; ${escapeHtml(entry.location)}</span>` : ''}
          </div>
        </div>
      </div>`;
    }
    const title = entry.text ? entry.text.split('\n')[0].slice(0, 60) + (entry.text.length > 60 ? '...' : '') : 'Memory';
    const date = formatDateShort(entry.date);
    return `<div class="highlight-item" data-detail="${entry.id}">
      ${thumb}
      <div class="highlight-info">
        <div class="highlight-title">${escapeHtml(title)}</div>
        <div class="highlight-sub">
          <span class="highlight-date">${date}</span>
          ${entry.location ? `<span>&#128205; ${escapeHtml(entry.location)}</span>` : ''}
        </div>
      </div>
    </div>`;
  }

  function attachHighlightListeners(container) {
    container.querySelectorAll('.highlight-item').forEach(item => {
      item.addEventListener('click', () => openDetailModal(item.dataset.detail));
    });
  }

  // ===================================================================
  //  HELPERS
  // ===================================================================
  function refreshCurrentView() {
    if (currentView === 'highlights') loadHighlights();
    else if (currentView === 'map') initMainMap();
    else if (currentView === 'search') performSearch();
  }

  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function formatDate(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  }

  function formatDateShort(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }

  function formatTime(timeStr) {
    const [h, m] = timeStr.split(':');
    const hour = parseInt(h);
    const ampm = hour >= 12 ? 'pm' : 'am';
    const h12 = hour % 12 || 12;
    return `${h12}:${m}${ampm}`;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
})();
