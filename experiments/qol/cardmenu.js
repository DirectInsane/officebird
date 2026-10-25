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

  // The class is the one of the table view's delete column: Thunderbird's list deletes
  // the row when a button carrying it is clicked.
  function addDelete(card) {
    const star = card.querySelector(".thread-card-icon-info > .button-star");
    if (!star || card.querySelector(".qol-delete")) {
      return Boolean(star);
    }
    const button = card.ownerDocument.createElement("button");
    button.type = "button";
    button.className = "button-flat qol-delete tree-button-request-delete";
    button.tabIndex = -1;
    button.setAttribute("aria-hidden", "true");
    button.setAttribute("data-l10n-id", "threadpane-column-header-delete");
    const info = star.parentElement;
    info.insertBefore(button, card.querySelector(".thread-card-icon-info > .tree-button-more") ?? star);
    return true;
  }

  return { place, addDelete };
})();
