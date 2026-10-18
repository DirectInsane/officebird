// Classic script, not a module: the experiment loads it into a sandbox, the tests with vm.
"use strict";

var qolCardMenu = (() => {
  // Thunderbird finds the button by its class wherever it sits. Cards are refilled on
  // every scroll, so nothing moves when the button is already in place.
  function place(card, beside) {
    const button = card.querySelector(".tree-button-more");
    const star = card.querySelector(".thread-card-icon-info > .button-star");
    const senderRow = card.querySelector(".thread-card-row");
    if (!button || !star || !senderRow) {
      return false;
    }
    if (beside) {
      if (button.nextElementSibling !== star) {
        star.parentElement.insertBefore(button, star);
      }
    } else if (button.parentElement !== senderRow) {
      senderRow.append(button);
    }
    return true;
  }

  return { place };
})();
