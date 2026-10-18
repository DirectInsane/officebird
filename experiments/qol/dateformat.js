// Classic script, not a module: the experiment's sandbox, options.html and vm tests load it.
"use strict";

var qolDateFormat = (() => {
  const STYLES = Object.freeze(["smart", "relative", "date", "datetime", "thunderbird"]);
  const DAY_MS = 86400000;
  const WEEK_DAYS = 6;

  const cache = new Map();
  function fmt(locale, options) {
    const key = locale + JSON.stringify(options);
    if (!cache.has(key)) {
      cache.set(key, new Intl.DateTimeFormat(locale, options));
    }
    return cache.get(key);
  }

  const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const time = (d, locale) => fmt(locale, { hour: "2-digit", minute: "2-digit" }).format(d);
  const shortDate = (d, locale) => fmt(locale, { day: "2-digit", month: "2-digit", year: "2-digit" }).format(d);

  function calendarDate(d, now, locale) {
    return d.getFullYear() === now.getFullYear()
      ? fmt(locale, { day: "numeric", month: "short" }).format(d)
      : shortDate(d, locale);
  }

  function smart(d, now, locale) {
    const today = startOfDay(now);
    const day = startOfDay(d);
    if (day === today) {
      return time(d, locale);
    }
    if (day < today && day >= today - WEEK_DAYS * DAY_MS) {
      return `${fmt(locale, { weekday: "short" }).format(d)} ${time(d, locale)}`;
    }
    return calendarDate(d, now, locale);
  }

  function relative(d, now, locale) {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
    const minutes = Math.floor((now - d) / 60000);
    if (minutes < 1) {
      return rtf.format(0, "second");
    }
    if (minutes < 60) {
      return rtf.format(-minutes, "minute");
    }
    const today = startOfDay(now);
    const day = startOfDay(d);
    if (day === today) {
      return rtf.format(-Math.floor(minutes / 60), "hour");
    }
    if (day === today - DAY_MS) {
      return rtf.format(-1, "day");
    }
    return calendarDate(d, now, locale);
  }

  // Returns null to keep Thunderbird's own text.
  function format(date, style, now, locale) {
    // Dates may come from another global (a Thunderbird window), where
    // instanceof Date is false.
    if (Object.prototype.toString.call(date) !== "[object Date]" || Number.isNaN(date.getTime())) {
      return null;
    }
    switch (style) {
      case "smart":
        return smart(date, now, locale);
      case "relative":
        return relative(date, now, locale);
      case "date":
        return shortDate(date, locale);
      case "datetime":
        return `${shortDate(date, locale)}, ${time(date, locale)}`;
      default:
        return null;
    }
  }

  function full(date, locale) {
    return fmt(locale, { dateStyle: "full", timeStyle: "short" }).format(date);
  }

  return Object.freeze({ STYLES, format, full });
})();
