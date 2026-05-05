# Face Breath for Windows (WinUI 3)

このドキュメントは Windows 版 Face Breath のインストールと起動手順です。

## 対象

- Windows 10/11
- .NET SDK 10
- Visual Studio 2022 (任意: デバッグ用途)

## 1. 前提ツールのインストール

1. .NET SDK 10 をインストール
2. WinUI 3 テンプレートをインストール

```powershell
dotnet new install Microsoft.WindowsAppSDK.WinUI.CSharp.Templates
```

## 2. 依存関係の復元

リポジトリルートで実行します。

```powershell
dotnet restore Win/FaceBreathWin/FaceBreathWin.csproj
```

## 3. ビルド

```powershell
dotnet build Win/FaceBreathWin/FaceBreathWin.csproj -p:Platform=x64
```

## 4. 実行

```powershell
dotnet run --project Win/FaceBreathWin/FaceBreathWin.csproj -p:Platform=x64
```

## 5. カメラ権限

本アプリは呼吸推定にカメラを使用します。初回起動時の許可ダイアログでカメラアクセスを許可してください。

## 6. トラブルシュート

- XAML コンパイルエラーが出る場合:
  - `dotnet clean Win/FaceBreathWin/FaceBreathWin.csproj`
  - その後 `dotnet build` を再実行
- パッケージ復元エラーが出る場合:
  - ネットワーク接続を確認し `dotnet restore` を再実行
- `REGDB_E_CLASSNOTREG (0x80040154)` が起動時に出る場合:
  - `dotnet clean Win/FaceBreathWin/FaceBreathWin.csproj`
  - `dotnet build Win/FaceBreathWin/FaceBreathWin.csproj -p:Platform=x64`
  - `dotnet run --project Win/FaceBreathWin/FaceBreathWin.csproj -p:Platform=x64 --launch-profile "FaceBreathWin (Unpackaged)"`
- カメラ初期化に失敗する場合:
  - 他アプリがカメラを使用中でないか確認
  - Windows のプライバシー設定でカメラ許可を確認

## プロジェクト場所

- WinUI 3 プロジェクト: `Win/FaceBreathWin`
- ソリューション: `Win/face_breath.sln`
