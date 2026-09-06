# GUI 도구 빌드

Python 소스는 `src/`, 아이콘은 `src/icons/`에 있습니다. OTA와 Wi-Fi 설정 아이콘은 각각 PNG(창), ICO(Windows), ICNS(macOS)로 제공합니다.

각 운영체제에서 직접 빌드하세요. Tkinter가 포함된 Python 3.10 이상과 C 컴파일러가 필요합니다. macOS는 python.org Python과 Xcode Command Line Tools(`xcode-select --install`), Windows는 python.org Python과 Visual Studio Build Tools의 C++ 빌드 도구를 권장합니다.

## macOS

저장소 루트에서:

```bash
python3 -m pip install -r tools/src/requirements-build.txt
bash tools/src/build_macos.sh
```

다른 Python을 지정하려면 `PYTHON=/path/to/python3 bash tools/src/build_macos.sh`를 사용하세요.
결과는 `tools/ota_gui.zip`, `tools/setup_wifi_gui.zip`입니다. 각 ZIP 하나만 배포하고, 사용자는 압축을 풀어 `.app`을 실행합니다. 빌드에 사용한 Python의 CPU 아키텍처를 따르며, 배포용 Developer ID 서명과 공증은 포함하지 않습니다.

macOS 빌드는 `ditto`로 `.app` 전체를 압축하고 ZIP 무결성을 검사합니다. 두 ZIP 모두 생성·검증된 후 `tools/`로 옮기고 기존 `.app`은 삭제합니다. 임시 `.app`과 빌드 중간 파일도 자동 정리됩니다.

## Windows (PowerShell)

```powershell
py -m pip install -r tools/src/requirements-build.txt
powershell -ExecutionPolicy Bypass -File tools/src/build_windows.ps1
```

다른 Python은 `-Python C:\path\to\python.exe`로 지정합니다.
결과는 `tools/ota_gui.exe`, `tools/setup_wifi_gui.exe`입니다. 각 `.exe` 하나만 배포하면 됩니다.

두 스크립트는 OTA와 Wi-Fi GUI를 임시 폴더에서 모두 빌드한 뒤 성공한 결과만 `tools/`로 옮깁니다. 실패하면 기존 결과물을 유지하며, 성공/실패 모두 임시 빌드 파일을 삭제합니다. macOS의 `.app`은 Finder에서 하나의 앱으로 표시되는 디렉터리 번들입니다. 현재 작업 디렉터리와 무관하게 스크립트 위치를 기준으로 경로를 처리합니다.

## 소스로 실행

```bash
python3 tools/src/setup_wifi_gui.py
python3 tools/src/ota_gui.py
python3 tools/src/setup_wifi.py  # CLI
```
