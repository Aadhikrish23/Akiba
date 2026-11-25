/* Shared chrome for the Ticket Stub Night mocks: the left rail, the top bar, and one icon set.
   <script src="shell.js" data-active="library"></script> as the first child of .app writes the rail in place. */
(function () {
  'use strict';
  var script = document.currentScript, active = script.getAttribute('data-active') || '';

  function svg(inner, cls) {
    return '<svg class="' + (cls || '') + '" viewBox="0 0 24 24" aria-hidden="true">' + inner + '</svg>';
  }
  var I = {
    home: '<path d="M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z"/>',
    schedule: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/><path d="M8.5 14.5h2M13.5 14.5h2"/>',
    discover: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>',
    library: '<rect x="4" y="4" width="4.5" height="16" rx="1"/><rect x="10" y="4" width="4.5" height="16" rx="1"/><path d="m16.5 6 3.5 1-3 13-3.5-1"/>',
    inbox: '<path d="M4 13h4l1.5 3h5L16 13h4"/><path d="M5.5 5h13L20 13v6H4v-6z"/>',
    history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    left: '<path d="m15 5-7 7 7 7"/>',
    right: '<path d="m9 5 7 7-7 7"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    undo: '<path d="M9 7 4 12l5 5"/><path d="M4 12h10a6 6 0 0 1 0 12"/>',
    grid: '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>',
    rows: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    star: '<path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 17l-5.2 2.7 1-5.9-4.3-4.1 5.9-.8z"/>'
  };
  var icon = function (name, cls) { return svg(I[name] || '', cls); };
  window.Shell = { icon: icon, I: I };

  var items = [
    ['home', 'Home', 'home.html#home', ' data-view="home"'],
    ['schedule', 'Schedule', 'home.html#schedule', ' data-view="schedule"'],
    ['discover', 'Discover', 'discover.html', ''],
    ['library', 'Library', 'library.html', ''],
    ['inbox', 'Inbox', 'inbox.html', '', '<span class="ct" id="inboxCt" aria-label="3 unread">3</span>'],
    ['history', 'History', '#', '']
  ];
  var html = '<nav class="rail" aria-label="Main"><a class="mark" href="home.html#home" aria-label="Akiba home">秋</a>';
  items.forEach(function (it) {
    html += '<a class="nav" href="' + it[2] + '"' + it[3] + (it[0] === active ? ' aria-current="page"' : '') + '>' + icon(it[0]) + it[1] + (it[4] || '') + '</a>';
  });
  html += '<div class="grow"></div><a class="nav" href="#">' + icon('settings') + 'Settings</a><div class="me" aria-label="Hana">H</div></nav>';
  script.insertAdjacentHTML('beforebegin', html);

  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('[data-top]').forEach(function (el) {
      el.className = 'top';
      el.innerHTML = '<a class="mark-m" href="home.html#home" aria-label="Akiba home">秋</a><label class="search">' + icon('search') + '<span class="sr">Search anime</span><input placeholder="Search anime, studios, characters" /><kbd>/</kbd></label>' +
        '<div class="clock"><b>Tuesday</b> · 11:42 pm · Fall 2026</div>';
    });
  });
})();
