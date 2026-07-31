# Design System

## Direction

收盤後的研究桌：深色、低眩光、安靜而精準。資訊像整齊攤開的研究筆記，不模仿交易終端機，也不靠霓虹與裝飾製造「專業感」。色彩策略採 restrained；品牌紅只用於主動操作與台股上漲語意，冷青用於選取、連結與資訊狀態。

## Color

所有色彩以 OKLCH token 管理。

```css
:root {
  --bg: oklch(0.105 0 0);
  --surface: oklch(0.155 0.008 25.7);
  --surface-raised: oklch(0.195 0.010 25.7);
  --ink: oklch(0.94 0.006 25.7);
  --muted: oklch(0.70 0.012 25.7);
  --line: oklch(0.29 0.012 25.7);
  --primary: oklch(0.665 0.222 25.7);
  --primary-strong: oklch(0.56 0.20 25.7);
  --accent: oklch(0.77 0.13 205);
  --up: oklch(0.70 0.20 25.7);
  --down: oklch(0.73 0.16 150);
  --warning: oklch(0.80 0.14 82);
  --danger: oklch(0.65 0.20 25.7);
}
```

紅漲綠跌遵守台股慣例，但每個數值同時帶正負號。品牌紅不鋪大面積背景；飽和色填滿元件時用近白文字。

## Typography

使用 `system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans TC", sans-serif`。數字使用 `font-variant-numeric: tabular-nums`。固定比例：12px 輔助、14px 標籤、16px 內文、20px 區段標題、28px 頁面標題；不使用展示字體或流動式標題。

## Layout

- 手機優先，375px 起完整操作；主內容最大寬度 1180px。
- 頂部顯示產品名與資料日期；手機底部導航，桌面左側窄導航。
- 清單用語意化表格呈現；手機改為逐列資訊帶，不使用巢狀卡片。
- 篩選條件與結果在桌面雙欄、手機單欄；控制項緊鄰受影響內容。
- 間距採 4/8/12/16/24/32px 節奏；區塊圓角上限 14px，控制項 10px。

## Components

- 按鈕：primary、secondary、quiet 三種，皆具 hover、focus-visible、active、disabled 與 loading。
- 表單：原生 input、checkbox、range，保持標準語意與 44px 最小觸控高度。
- 狀態：loading 用 skeleton；error 內嵌重試；empty state 直接教使用者第一步。
- 標籤：只描述命中條件、資料不足與風險，不作裝飾。
- 圖表：Canvas 繪製，旁邊提供期間、最大回撤、波動率與趨勢品質文字摘要。

## Motion

互動回饋 180ms，使用 ease-out；按下即以 `transform: scale(0.98)` 與色彩變化回應。列表更新只淡入或短距移動，不做編排式進場。`prefers-reduced-motion: reduce` 時移除位移與縮放，只保留短淡化或立即切換。

## Content

句子短、標籤具體。固定聲明為「符合條件 ≠ 建議買進，判斷永遠是你自己的」。任何缺值顯示「資料不足」，不可顯示 0 或空白造成誤解。
