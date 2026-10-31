// Classic script, not a module: the experiment loads it into a sandbox, the tests with vm.
"use strict";

var qolTodayModel = (() => {
  // Agenda rows carry their day as the start of an iCal date string: "20261029" or "20261029T140000".
  const DATE_STRING = /^(\d{4})(\d{2})(\d{2})/;

  function dateKey(date) {
    return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
  }

  function parse(dateString) {
    const m = DATE_STRING.exec(typeof dateString === "string" ? dateString : "");
    if (!m) return null;
    const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return dateKey(date) === m.slice(1, 4).join("") ? date : null;
  }

  // The day column of an agenda row: "Thu" over "29", or "Do" in German (without its dot).
  function dayParts(dateString, now, locale) {
    const date = parse(dateString);
    if (!date) return null;
    return {
      weekday: new Intl.DateTimeFormat(locale, { weekday: "short" }).format(date).replace(/\.$/, ""),
      day: String(date.getDate()),
      today: dateKey(date) === dateKey(now),
    };
  }

  // The agenda title; month is 0-based like Thunderbird's calIDateTime.
  function monthParts(year, month, locale) {
    const date = new Date(year, month, 1);
    return {
      month: new Intl.DateTimeFormat(locale, { month: "long" }).format(date),
      year: String(year),
    };
  }

  // Text on a custom highlight: black only on light colors, as white reads better on
  // mid tones like the usual accent blue than the plain contrast ratio suggests.
  function textOn(hex) {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (!m) return "white";
    const [r, g, b] = m.slice(1).map(part => {
      const c = parseInt(part, 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? "black" : "white";
  }

  return { dateKey, dayParts, monthParts, textOn };
})();
