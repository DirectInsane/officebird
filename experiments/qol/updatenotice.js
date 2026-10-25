// Classic script, not a module: the experiment loads it into a sandbox, the tests with vm.
"use strict";

var qolUpdateNotice = (() => {
  const STRINGS = {
    de: {
      message: "Officebird {version} ist bereit und wird beim nächsten Start von Thunderbird installiert.",
      restart: "Jetzt neu starten",
    },
    en: {
      message: "Officebird {version} is ready. It will be installed when Thunderbird restarts.",
      restart: "Restart now",
    },
  };

  function pickLanguage(locale) {
    return /^de(?:$|[-_])/i.test(String(locale || "")) ? "de" : "en";
  }

  function texts(lang, version) {
    const strings = STRINGS[lang] ?? STRINGS.en;
    return { message: strings.message.replace("{version}", version), restart: strings.restart };
  }

  return { STRINGS, pickLanguage, texts };
})();
