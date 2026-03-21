/**
 * weather.js — Weather widget display and expandable popup.
 */

import { fetchWeather } from "./api.js";

const SMHI_ICONS = {
    1:'☀️', 2:'🌤️', 3:'⛅', 4:'🌥️', 5:'🌫️', 6:'🌫️',
    7:'🌦️', 8:'🌧️', 9:'🌧️', 10:'⛈️', 11:'⛈️', 12:'⛈️', 13:'⛈️',
    14:'🌨️', 15:'❄️', 16:'❄️', 17:'❄️', 18:'🌨️', 19:'🌨️',
    20:'❄️', 21:'❄️', 22:'❄️', 23:'❄️', 24:'🌨️', 25:'🌨️',
    26:'❄️', 27:'❄️',
};

export async function updateWeather() {
    try {
        const w = await fetchWeather();
        document.getElementById('weather-temp').textContent =
            w.temp != null ? `${Math.round(w.temp)}°` : '--°';
        document.getElementById('weather-icon').textContent =
            SMHI_ICONS[w.symbol] ?? '🌡️';
        const wpTemp = document.getElementById('wp-temp');
        const wpWind = document.getElementById('wp-wind');
        const wpTime = document.getElementById('wp-time');
        if (wpTemp) wpTemp.textContent = w.temp != null ? `${w.temp}°C` : '--';
        if (wpWind) wpWind.textContent = w.wind != null ? `${w.wind} m/s` : '--';
        if (wpTime && w.valid_time) {
            wpTime.textContent = new Date(w.valid_time).toLocaleTimeString("sv-SE", {hour:"2-digit", minute:"2-digit"});
        }
    } catch (e) {
        console.warn('Weather update failed:', e);
    }
}

export function initWeatherWidget() {
    const widget = document.getElementById("weather-widget");
    if (!widget) return;
    widget.addEventListener("click", (e) => {
        e.stopPropagation();
        const popup = document.getElementById("weather-popup");
        if (popup) popup.classList.toggle("visible");
    });
    document.addEventListener("click", () => {
        const popup = document.getElementById("weather-popup");
        if (popup) popup.classList.remove("visible");
    });
}
