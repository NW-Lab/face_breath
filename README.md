# Face Breath — Respiratory Visualizer

**Bio-Lab Noir** テーマで統一された、映像ベースのリアルタイム呼吸推定 Web アプリケーション。iPhone の Safari で動作し、カメラ映像から顔・鼻孔・口・胸部の動きを解析して呼吸状態を推定する。EVM（Eulerian Video Magnification）的な映像増幅により、肉眼では見えない呼吸変化を派手に可視化する。

> **姉妹プロジェクト**: [face_blood](https://github.com/NW-Lab/face_blood) — rPPG による心拍推定（同じ Bio-Lab Noir テーマ）

---

## 機能概要

| 機能 | 説明 | 根拠手法 |
|------|------|----------|
| **呼吸数 (BPM)** | 顔 ROI の YCgCo Cg チャンネルから呼吸帯域（0.1–0.5 Hz）を FFT 解析 | Park & Hong 2023, Chen et al. 2019 |
| **鼻呼吸 / 口呼吸判別** | 鼻孔 ROI と口 ROI の呼吸信号強度比較 + 口の開閉度 | Nhan & Chung 2020, Huang et al. 2021 |
| **呼吸の深さ** | フィルタ済み呼吸波形の peak-to-peak 振幅（相対潮気量） | Fei & Pavlidis 2010 |
| **EVM 映像増幅** | 呼吸帯域の信号で顔・鼻孔・胸部の輝度変化を増幅して可視化 | Wu et al. 2012, Mattioli et al. 2023 |
| **信頼度 (SNR)** | 呼吸帯域内のピークパワー対帯域内全パワーの比 | Chen et al. 2019 |

---

## 手法の詳細

### 1. 顔 ROI からの呼吸信号抽出

顔の ROI（Region of Interest）から RGB 信号を取得し、YCgCo 色空間に変換する。**Cg チャンネル**（`Cg = G − (R + B) / 2`）は照明変動に対してロバストであり、呼吸に伴う皮膚色変化を捉えるのに有効であることが Park & Hong (2023) により示されている。

信号処理パイプラインは以下の通りである。

1. 各 ROI の RGB 平均を約 30fps で取得（リングバッファ 20 秒）
2. 均一サンプリングに線形補間でリサンプリング
3. 線形トレンド除去（detrend）
4. Hann 窓関数適用
5. DFT → 呼吸帯域（0.1–0.5 Hz = 6–30 BPM）でバンドパス
6. 放物線補間によるサブビン精度のピーク周波数推定
7. 逆 DFT で呼吸波形を再構成

### 2. FaceMesh ランドマークによる ROI 追跡

MediaPipe FaceMesh（468 ランドマーク）を使用して以下の ROI を動的に追跡する。

| ROI | ランドマーク | 用途 |
|-----|------------|------|
| 鼻孔 ROI | #1, #2, #326 周辺 | 鼻呼吸信号（Nhan & Chung 2020） |
| 口 ROI | #13, #14 周辺 | 口呼吸信号・口の開閉度 |
| 顔 ROI | 額・頬（中央 55%） | 主要呼吸信号（Park & Hong 2023） |
| 胸部 ROI | カメラ下部 30% | 胸郭動きの輝度変化 |

### 3. 鼻呼吸 / 口呼吸の判別

Huang et al. (2021) の手法を RGB カメラ向けに適応した。鼻孔 ROI の呼吸帯域パワーと口 ROI の呼吸帯域パワーを比較し、さらに口の開閉度（上唇・下唇ランドマーク間距離）を補助指標として用いる。

- **鼻呼吸**: 鼻孔 ROI パワー > 55% かつ口が閉じている
- **口呼吸**: 口 ROI パワー > 55% かつ口が開いている
- **混合**: 上記いずれにも該当しない

### 4. 呼吸の深さ（相対潮気量）

Fei & Pavlidis (2010) に基づき、フィルタ済み呼吸波形の peak-to-peak 振幅を相対的な潮気量の代理指標として使用する。絶対値ではなく相対値（0–100%）として表示する。

### 5. EVM 的映像増幅（呼吸版）

Wu et al. (2012) の Eulerian Video Magnification と Mattioli et al. (2023) の呼吸モニタリング向け動き増幅手法を参考に、3 段階の増幅モードを実装した。

| モード | 増幅倍率 | 対象領域 | 視覚効果 |
|--------|---------|---------|---------|
| **SUBTLE** | ×1 | 鼻孔・口周辺 | 柔らかいシアン/アンバーのグロー |
| **VIVID** | ×3 | 顔全体 + 胸部 | 呼吸と同期した青緑〜アンバーの脈動 |
| **EXTREME** | ×6 | 全身（肌色ピクセル） | ピクセル単位の輝度シフト + 全画面ティント |

---

## 動作環境

- **推奨**: iPhone Safari（iOS 14.5 以降）
- **その他**: Chrome / Firefox / Edge（最新版）
- **必要**: カメラアクセス許可、HTTPS 接続

---

## 使い方

1. アプリを開き「計測開始」をタップ
2. カメラ許可を承認する
3. 顔全体（できれば胸・肩まで）がカメラに映るよう距離を調整する
4. 約 6 秒のキャリブレーション後、計測が開始される
5. 増幅モード（SUBTLE / VIVID / EXTREME）と AMP スライダで視覚効果を調整する

---

## 技術スタック

- **フロントエンド**: React 19 + TypeScript + Tailwind CSS 4
- **顔検出**: MediaPipe FaceMesh（CDN 経由）
- **信号処理**: カスタム DFT / バンドパスフィルタ（`src/lib/breathing.ts`）
- **映像処理**: Canvas 2D API（EVM 増幅オーバーレイ）
- **フォント**: Space Grotesk + JetBrains Mono（Bio-Lab Noir テーマ）

---

## 根拠論文・文献リスト

### 映像ベース呼吸数推定

1. **Chen, W., & McDuff, D. (2019).** *DeepPhys: Video-Based Physiological Measurement Using Convolutional Attention Networks.* arXiv:1909.03503 / IEEE BHI 2019.
   顔映像から rPPG 信号を抽出し、呼吸帯域の成分として呼吸数を推定する二段階時間フィルタリング手法を提案。本アプリの顔 ROI 信号処理パイプラインの基礎。
   URL: https://arxiv.org/abs/1909.03503

2. **Park, J., & Hong, K. (2023).** *Facial Video-Based Robust Measurement of Respiratory Rates in Various Environmental Conditions.* Journal of Sensors, 2023, 9207750.
   DOI: 10.1155/2023/9207750
   YCgCo 色空間変換と partial zero-padding FFT/iFFT を用いた顔映像からの呼吸数推定。本アプリの Cg チャンネル抽出と FFT 解析の直接的な根拠。

3. **Wiede, C., Richter, J., & Hirtz, G. (2017).** *Remote respiration rate determination using RGB cameras.* VISAPP 2017.
   RGB カメラによる非接触呼吸数計測の比較研究。顔 ROI の RGB 信号から呼吸帯域を抽出する手法の検証。

4. **Maxwell, A., et al. (2023).** *Non-Contact Breathing Rate Detection Using Optical Flow.* arXiv:2311.08426.
   オプティカルフローを用いた非接触呼吸数検出。胸部 ROI の動き解析手法の参考。
   URL: https://arxiv.org/abs/2311.08426

### 鼻孔追跡・鼻/口呼吸判別

5. **Nhan, B. R., & Chung, C. (2020).** *Tracking nostril movement in facial video for respiratory rate estimation.* IEEE EMBC 2020.
   DOI: 10.1109/EMBC44109.2020.9225464
   顔映像中の鼻孔ランドマーク追跡による呼吸数推定。本アプリの鼻孔 ROI 設計の根拠。

6. **Huang, Q., et al. (2021).** *Nose breathing or mouth breathing? A thermography-based new measurement for sleep monitoring.* CVPR Workshop 2021.
   サーモグラフィを用いた鼻/口呼吸判別手法。本アプリでは RGB カメラ向けに適応し、ROI 信号パワー比と口の開閉度を組み合わせた判別ロジックを実装。

7. **Murthy, J. N., & Pavlidis, I. (2006).** *Non-contact measurement of breathing function.* IEEE Engineering in Medicine and Biology Magazine, 25(3), 57–67.
   DOI: 10.1109/MEMB.2006.1636352
   非接触呼吸計測の先駆的研究。鼻孔周辺の熱放射変化を用いた呼吸検出の基礎理論。

### EVM 映像増幅（呼吸版）

8. **Wu, H. Y., Rubinstein, M., Shih, E., Guttag, J., Durand, F., & Freeman, W. T. (2012).** *Eulerian Video Magnification for Revealing Subtle Changes in the World.* ACM SIGGRAPH 2012.
   DOI: 10.1145/2185520.2185561
   URL: https://people.csail.mit.edu/mrub/evm/
   ラプラシアンピラミッド分解と時間フィルタリングによる映像増幅の基礎論文。本アプリの EVM 増幅モードの理論的根拠。

9. **Wadhwa, N., Rubinstein, M., Durand, F., & Freeman, W. T. (2013).** *Phase-Based Video Motion Processing.* ACM SIGGRAPH 2013.
   DOI: 10.1145/2461912.2461966
   位相ベースの映像動き処理。より大きな増幅倍率を実現する手法。EXTREME モードの参考。

10. **Alam, M. A., et al. (2017).** *Considerations of handheld respiratory rate estimation via a stabilized Video Magnification approach.* IEEE EMBC 2017.
    DOI: 10.1109/EMBC.2017.8037805
    手持ちカメラでの EVM を用いた呼吸数推定。手ブレ補正と呼吸帯域増幅の実装上の知見。

11. **Mattioli, F., et al. (2023).** *Motion magnification algorithms for video-based breathing monitoring.* Biomedical Signal Processing and Control, 86, 105148.
    DOI: 10.1016/j.bspc.2023.105148
    映像ベース呼吸モニタリングのための動き増幅アルゴリズム比較研究。本アプリの増幅モード設計の直接的な参考。

### 呼吸の深さ（相対潮気量）推定

12. **Fei, J., & Pavlidis, I. (2010).** *A novel method for extracting respiration rate and relative tidal volume from infrared thermography.* Psychophysiology, 47(5), 877–886.
    DOI: 10.1111/j.1469-8986.2010.01167.x
    サーモグラフィ映像から呼吸数と相対潮気量を抽出する手法。peak-to-peak 振幅を相対的な潮気量の代理指標として使用するアプローチの根拠。

13. **Murthy, J. N., & Pavlidis, I. (2006).** *(前掲 [7])* — 呼吸の深さ推定の基礎理論も含む。

### rPPG ベース呼吸推定

14. **Verkruysse, W., Svaasand, L. O., & Nelson, J. S. (2008).** *Remote plethysmographic imaging using ambient light.* Optics Express, 16(26), 21434–21445.
    DOI: 10.1364/OE.16.021434
    環境光を用いた遠隔 PPG 計測の先駆的論文。rPPG 信号から心拍だけでなく呼吸成分も抽出できることを示した。

15. **Liu, X., et al. (2020).** *Multi-Task Temporal Shift Attention Networks for On-Device Contactless Vitals Measurement.* NeurIPS 2020.
    URL: https://arxiv.org/abs/2006.03790
    深層学習による心拍・呼吸の同時推定（MTTS-CAN）。映像ベース生体信号推定の最新手法として参照。

---

## ライセンス

MIT License

---

## 謝辞

本アプリは上記の学術研究に基づいて実装されています。各論文の著者に感謝します。
映像ベース呼吸推定は研究用途であり、医療診断目的には使用しないでください。
