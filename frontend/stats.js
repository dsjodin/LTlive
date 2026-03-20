import { fetchStats } from "./modules/api.js";

function fmt(secs) {
    if (secs == null) return '–';
    if (secs < 60) return secs + 's';
    return Math.floor(secs / 60) + 'm ' + (secs % 60) + 's';
}
function fmtTime(epoch) {
    return new Date(epoch * 1000).toLocaleString('sv-SE');
}

fetchStats()
    .then(data => {
        const periods = [
            { key: 'today',    label: 'Idag' },
            { key: 'week',     label: '7 dagar' },
            { key: 'month',    label: '30 dagar' },
            { key: 'all_time', label: 'Totalt' },
        ];
        const summary = document.getElementById('summary');
        periods.forEach(p => {
            const d = data[p.key];
            const card = document.createElement('div');
            card.className = 'card';
            card.innerHTML = `<div class="card-label">${p.label}</div>
                <div class="card-value">${d.visits}</div>
                <div class="card-sub">${d.unique} unika · avg ${fmt(d.avg_duration)}</div>`;
            summary.appendChild(card);
        });

        const pagesTbody = document.querySelector('#pages-table tbody');
        data.top_pages.forEach(r => {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td class="page">${r.page}</td><td>${r.visits}</td>`;
            pagesTbody.appendChild(tr);
        });

        const recentTbody = document.querySelector('#recent-table tbody');
        data.recent.forEach(r => {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td class="page">${r.page}</td><td>${fmtTime(r.started_at)}</td><td class="dur">${fmt(r.duration)}</td>`;
            recentTbody.appendChild(tr);
        });
    })
    .catch(err => {
        const p = document.createElement('p');
        p.className = 'error';
        p.textContent = `Kunde inte hämta statistik: ${err.message}`;
        document.getElementById('summary').appendChild(p);
    });
