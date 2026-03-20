(function () {
    var s = Math.random().toString(36).slice(2);
    var t = Date.now();
    var p = location.pathname;
    fetch('/api/stats/visit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: s, page: p }),
        keepalive: true,
    }).catch(function () {});
    function leave() {
        navigator.sendBeacon(
            '/api/stats/leave',
            JSON.stringify({ session_id: s, duration: Math.round((Date.now() - t) / 1000) })
        );
    }
    window.addEventListener('beforeunload', leave);
    document.addEventListener('visibilitychange', function () { if (document.hidden) leave(); });
})();
