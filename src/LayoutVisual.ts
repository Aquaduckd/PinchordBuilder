const COLOR_INITIAL = "#ff0000";
const COLOR_VOWEL = "#729fcf";
const COLOR_FINAL = "#81d41a";
/** Gray for keys not in any bank; distinct from canvas background (#374151). */
const COLOR_DEFAULT = "#6b7280";
export class LayoutVisual {
  private readonly canvas: HTMLCanvasElement;
  private readonly container: HTMLElement;
  private resizeObserver: ResizeObserver | null = null;
  private keyLabels: string[] = [];
  private banks: { initials: string; vowels: string; finals: string } | null = null;
  private highlightedLeftKeys: Set<string> = new Set();
  private highlightedRightKeys: Set<string> = new Set();
  private highlightedCenterKeys: Set<string> = new Set();

  constructor(canvas: HTMLCanvasElement, container?: HTMLElement) {
    this.canvas = canvas;
    this.container = container ?? (canvas.parentElement as HTMLElement);
  }

  setKeyLabels(labels: string[]): void {
    this.keyLabels = labels.length >= 24 ? labels.slice(0, 24) : [];
    this.draw();
  }

  setBanks(banks: { initials: string; vowels: string; finals: string } | null): void {
    this.banks = banks;
    this.draw();
  }

  setHighlightedKeys(
    leftKeys: Set<string> | string[],
    rightKeys: Set<string> | string[],
    centerKeys?: Set<string> | string[]
  ): void {
    this.highlightedLeftKeys = new Set(leftKeys);
    this.highlightedRightKeys = new Set(rightKeys);
    this.highlightedCenterKeys = new Set(centerKeys ?? []);
    this.draw();
  }

  draw(): void {
    const rect = this.container.getBoundingClientRect();
    const dpr = window.devicePixelRatio ?? 1;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.canvas.style.width = rect.width + "px";
    this.canvas.style.height = rect.height + "px";

    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    const pad = 8;
    const gap = 4;
    const halfW = w / 2;

    ctx.fillStyle = "#374151";
    ctx.fillRect(0, 0, w, h);

    const availW = halfW - pad * 2;
    const size = Math.min(
      (availW - 5 * gap) / 6,
      (h - 2 * gap) / 4.25
    );
    const colW = size + gap;
    const tallH = size * 2 + gap;

    const leftOffsets = [0.75, 0.75, 0.25, 0, 0.25, 0.25];
    const rightOffsets = [...leftOffsets].reverse();

    const contentHeight = 4.25 * size + 2 * gap;
    const topPad = (h - contentHeight) / 2;

    // Draw position 1-24 → display index: 1-12 unchanged, 23-24→13-14, then 13→15..22→24
    const DISPLAY_INDEX = [
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
      15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
      13, 14,
    ];

    const keyColorByBanks = (keyName: string, indexInKeyOrder: number): string => {
      if (!this.banks || !keyName) return COLOR_DEFAULT;
      const inInitial = this.banks.initials.includes(keyName);
      const inVowel = this.banks.vowels.includes(keyName);
      const inFinal = this.banks.finals.includes(keyName);
      const firstOccurrence = this.keyLabels.indexOf(keyName) === indexInKeyOrder;
      // Character in both initial and vowel, or both initial and final: first = initial (red), later = final (green)
      if (inInitial && (inVowel || inFinal)) return firstOccurrence ? COLOR_INITIAL : COLOR_FINAL;
      if (inInitial) return COLOR_INITIAL;
      if (inVowel) return COLOR_VOWEL;
      if (inFinal) return COLOR_FINAL;
      return COLOR_DEFAULT;
    };

    const keyColorByPosition = (k: number): string => {
      if (k <= 3) return "#8d281e";
      if (k <= 10) return "#ff0000";
      if ((k >= 11 && k <= 13) || (k >= 23 && k <= 24)) return "#729fcf";
      if (k >= 14 && k <= 21) return "#81d41a";
      if (k === 22) return "#00a933";
      return COLOR_DEFAULT;
    };

    const hasHighlight =
      this.highlightedLeftKeys.size > 0 ||
      this.highlightedRightKeys.size > 0 ||
      this.highlightedCenterKeys.size > 0;
    const grayedFill = "#4b5563";
    const grayedText = "#9ca3af";
    let n = 1;
    const label = (c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void => {
      const displayIdx = DISPLAY_INDEX[n - 1] ?? n;
      const indexInKeyOrder = displayIdx - 1;
      const keyName = this.keyLabels[indexInKeyOrder];
      const isLeft = n <= 12;
      const isHighlighted =
        !hasHighlight ||
        (keyName !== undefined &&
          (this.highlightedCenterKeys.has(keyName) ||
            (isLeft ? this.highlightedLeftKeys.has(keyName) : this.highlightedRightKeys.has(keyName))));
      const fillColor = this.banks
        ? keyColorByBanks(keyName ?? "", indexInKeyOrder)
        : keyColorByPosition(n);
      c.fillStyle = isHighlighted ? fillColor : grayedFill;
      c.fillRect(x, y, w, h);
      c.fillStyle = isHighlighted ? "#e5e7eb" : grayedText;
      c.font = `${Math.max(10, Math.floor(size * 0.4))}px sans-serif`;
      c.textAlign = "center";
      c.textBaseline = "middle";
      const text = keyName !== undefined ? keyName : String(displayIdx);
      c.fillText(text, x + w / 2, y + h / 2);
      n += 1;
    };

    for (let col = 0; col < 6; col++) {
      const x = pad + col * colW;
      const y = topPad + leftOffsets[col] * size;
      if (col === 0 || col === 5) {
        label(ctx, x, y, size, tallH);
      } else {
        label(ctx, x, y, size, size);
        label(ctx, x, y + size + gap, size, size);
      }
    }
    const leftCol4Y = topPad + leftOffsets[4] * size;
    label(ctx, pad + 4 * colW, leftCol4Y + 2 * (size + gap) + size, size, size);
    const leftCol5Y = topPad + leftOffsets[5] * size;
    label(ctx, pad + 5 * colW, leftCol5Y + tallH + gap + size, size, size);

    for (let col = 0; col < 6; col++) {
      const x = halfW + pad + col * colW;
      const y = topPad + rightOffsets[col] * size;
      if (col === 0 || col === 5) {
        label(ctx, x, y, size, tallH);
      } else {
        label(ctx, x, y, size, size);
        label(ctx, x, y + size + gap, size, size);
      }
    }
    const rightCol0Y = topPad + rightOffsets[0] * size;
    label(ctx, halfW + pad, rightCol0Y + tallH + gap + size, size, size);
    const rightCol1Y = topPad + rightOffsets[1] * size;
    label(ctx, halfW + pad + colW, rightCol1Y + 2 * (size + gap) + size, size, size);
  }

  attach(): void {
    this.draw();
    this.resizeObserver = new ResizeObserver(() => this.draw());
    this.resizeObserver.observe(this.container);
  }

  detach(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
  }
}
