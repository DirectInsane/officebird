// Classic script, not a module: the experiment loads it into a sandbox, the tests with vm.
"use strict";

var qolGroupRows = (() => {
  // Thunderbird's list assumes every row is ROW_HEIGHT tall and works in those "virtual"
  // pixels (scroll position, spacers); header rows are only headerHeight tall, so real
  // positions differ by what each header above saves. `headers` must be sorted.
  function layout(headers, rowHeight, headerHeight) {
    const saved = rowHeight - headerHeight;
    const set = new Set(headers);

    function before(index) {
      let lo = 0;
      let hi = headers.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (headers[mid] < index) {
          lo = mid + 1;
        } else {
          hi = mid;
        }
      }
      return lo;
    }

    const realTop = index => index * rowHeight - before(index) * saved;

    function toReal(v) {
      const index = Math.floor(v / rowHeight);
      const offset = v - index * rowHeight;
      return realTop(index) + (set.has(index) ? (offset * headerHeight) / rowHeight : offset);
    }

    function toVirtual(y) {
      let shift = 0;
      for (const index of headers) {
        const top = index * rowHeight - shift;
        if (y < top) {
          break;
        }
        if (y < top + headerHeight) {
          return index * rowHeight + ((y - top) * rowHeight) / headerHeight;
        }
        shift += saved;
      }
      return y + shift;
    }

    return {
      toReal,
      toVirtual,
      isHeader: index => set.has(index),
      rowSpan(index) {
        const top = realTop(index);
        return { top, bottom: top + (set.has(index) ? headerHeight : rowHeight) };
      },
      topSpacer(height) {
        return height - before(Math.round(height / rowHeight)) * saved;
      },
      bottomSpacer(height, rowCount) {
        const first = rowCount - Math.round(height / rowHeight);
        return height - (headers.length - before(first)) * saved;
      },
      totalHeight: rowCount => realTop(rowCount),
    };
  }

  return { layout };
})();
