# Face Breath — Design Brainstorm
iPhone Safari でカメラを使い、顔・鼻孔・胸部の動きから呼吸を推定し、EVM（Eulerian Video Magnification）的に呼吸変化を「派手に」可視化するアプリ。face_blood と同じ Bio-Lab Noir テーマで統一感を持たせる。

---

<response>
<text>
**A. Bio-Lab Noir — Respiratory Edition（採用）**
- **Design Movement**: Medical/Scientific Instrumentation × Cyberpunk HUD。呼吸計測装置（スパイロメーター・ポリソムノグラフ）のような「計測の実感」を、暗室で見るネオン信号の美しさで包む。face_blood の arterial red を「respiratory cyan/green」に置き換え、同じ設計言語で呼吸版を構築。
- **Core Principles**:
  1. *Breath as signal* — 呼吸数(BPM)・深さ・鼻/口判別が常に画面上に並走し、「本物の計測」だと感じさせる。
  2. *Expanding chromatic energy* — 鼻孔・口・胸部 ROI に重ねる増幅オーバーレイは、呼吸の位相と完全同期して青緑〜シアン〜アンバーへ脈動する。
  3. *Asymmetric HUD* — 中央に映像、右にバイタル数値、左下に波形、上にステータスバーという非対称なコックピット型（face_blood と同じ構造）。
  4. *Honest about uncertainty* — 信号品質が低い場合は警告を出し、嘘をつかない。
- **Color Philosophy**:
  - 背景は深い炭黒（`oklch(0.13 0.02 260)`）— face_blood と同一。
  - **primary accent**: respiratory cyan `oklch(0.78 0.16 200)` — 酸素の青緑。
  - **secondary accent**: breath amber `oklch(0.82 0.18 90)` — 呼気の温かさ。
  - **nasal indicator**: oxy green `oklch(0.75 0.20 150)` — 鼻呼吸。
  - **oral indicator**: warm orange `oklch(0.72 0.22 60)` — 口呼吸。
  - face_blood の arterial red は警告・エラー用に温存。
- **Layout Paradigm**:
  - フルブリードのカメラ映像の上に、左寄せの `BPM` 巨大数値、右寄せに波形＆深さ指標、上部に細い HUD ステータスバー、下部に開始/停止と増幅スライダ。
  - スマホ縦持ちを基準に、`safe-area-inset` を尊重した HUD レイアウト。
- **Signature Elements**:
  1. 鼻孔・口周辺に重なる「拡張する楕円形メッシュ」状の呼吸オーバーレイ。
  2. 画面左に縦に流れるリアルタイム呼吸波形（スパイロメーター風）。
  3. 呼吸ごとに画面の縁が一瞬だけシアンに広がる "breath vignette"。
- **Interaction Philosophy**:
  - タップは最小限。開始/停止と「増幅倍率」スライダだけ。
  - face_blood と同じ SUBTLE/VIVID/EXTREME モード切り替え。
- **Animation**:
  - 呼吸の位相に同期した増幅オーバーレイ（吸気: 拡張・明化 / 呼気: 収縮・暗化）。
  - BPM 数値はスプリングアニメーション、波形は requestAnimationFrame でスクロール。
  - 起動時は HUD 要素が下からフェード＆スライドイン。
- **Typography System**:
  - 計測数値: **JetBrains Mono** 700。
  - 見出し/ラベル: **Space Grotesk** 500/700。
  - Inter は使わない（face_blood と同一方針）。
</text>
<probability>0.07</probability>
</response>

<response>
<text>
**B. Pulmonary Atlas（不採用）**
- 19世紀の解剖図譜風。セピア背景に気管・肺の断面図イラスト、呼吸波形を重ねる。
- 文学的で美しいが、リアルタイム計測アプリには重すぎる。
</text>
<probability>0.03</probability>
</response>

<response>
<text>
**C. Minimal Vital（不採用）**
- 白背景にモノクロの波形だけ。シンプルすぎてface_bloodとの統一感がない。
</text>
<probability>0.02</probability>
</response>

---

**採用: A. Bio-Lab Noir — Respiratory Edition**
face_blood と同じ設計言語（炭黒背景、HUD レイアウト、JetBrains Mono + Space Grotesk、スキャンライン）を踏襲しつつ、呼吸版のアクセントカラー（シアン・アンバー・グリーン）で差別化する。
