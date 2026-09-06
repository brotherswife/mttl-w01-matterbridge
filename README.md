# MTTL-W01 MatterBridge

한국어 | [English](README.en.md)

LG MTTL-W01 4구 IoT 멀티탭을 로컬에서 Matter로 변환해 SmartThings등의 플랫폼과 웹 대시보드에서 사용할 수 있게 해주는 브리지입니다.

 - 순정 펌웨어에서 동작하며, 공유기의 DNAT나 DNS변경이 필요 없습니다.
 - MQTT가 아닌 내부 TCP프로토콜로 직접 통신하며, 순정 펌웨어에서는 기본 10초 주기로 상태를 조회합니다.
 - 즉각적인 상태 변경이 필요하다면 커스텀 펌웨어를 적용하시기 바랍니다. (네이버 HomeAssistant, 모두의 스마트홈 카페 참고)
 - 각 콘센트의 전원을 제어하고 현재 소비전력과 누적 전력량을 확인할 수 있습니다.

설정은 **브리지 실행 → 멀티탭 Wi-Fi 설정 → Matter 앱에 추가** 순서로 진행합니다. 브리지를 실행하는 서버는 멀티탭을 사용할 동안 켜 두어야 합니다.

## 1. 준비하기

- LG MTTL-W01 멀티탭
- Docker를 실행할 Linux 서버(라즈베리파이 등) 또는 Linux 기반 NAS
- 멀티탭 Wi-Fi 설정에 사용할 Windows 또는 macOS PC
- SmartThings, Apple Home, Google Home 등 Matter를 지원하는 앱과 해당 플랫폼에서 요구하는 허브·컨트롤러

서버, 멀티탭, Matter 컨트롤러를 같은 공유기의 내부 네트워크에 연결하세요.

서버에 Docker Engine과 Compose 플러그인을 설치합니다. 운영체제별 설치 방법은 [Docker 설치 안내](https://docs.docker.com/engine/install/)를 참고하세요. 설치 후 터미널에서 다음 명령이 실행되는지 확인합니다.

```bash
docker version
docker compose version
```

## 2. Docker로 브리지 실행하기

서버에서 설정을 보관할 폴더를 만듭니다.

```bash
mkdir mttl-bridge
cd mttl-bridge

nano docker-compose.yml
# 아래 내용을 붙여넣고 Ctrl+O 눌러 저장합니다.
```

이 폴더에 `docker-compose.yml` 파일을 만들고 아래 내용을 저장하세요. 저장소에 포함된 로컬 빌드용 Compose 대신, 아래 설정을 사용하면 Docker Hub 이미지를 실행합니다.

```yaml
services:
  mttl-bridge:
    image: ttaengz/mttl-w01-matterbridge:latest
    network_mode: host
    restart: unless-stopped
    stop_grace_period: 30s
    environment:
      HTTP_PORT: 8086
      MATTER_PORT: 5540
      MTTL_POLL_INTERVAL_MS: 10000
      MTTL_RESPONSE_TIMEOUT_MS: 3000
    volumes:
      - ./devices:/app/data
      - ./matter:/root/.matter
```

같은 폴더에서 다음 명령을 실행합니다.

```bash
docker compose up -d

# 서버 종료하기:
# docker compose down
```

브라우저에서 `http://{서버IP주소}:8086`을 여세요. 대시보드가 표시되면 서버 준비가 끝났습니다.

서버 포트 변경방법:
 - 동일한 서버에서 다른 Matter 관련 서비스가 구동중이라면 MATTER_PORT를 변경해주세요.
    - 예) `MATTER_PORT: 5541`

 - 웹 대시보드 서버 포트도 다음 환경변수로 변경 가능합니다.
    - 예) `HTTP_PORT: 8080` (`http://{서버IP주소}:8080` 접속)


## 3. 멀티탭 Wi-Fi와 서버 주소 설정하기

PC 운영체제에 맞는 Wi-Fi 설정 도구를 내려받으세요. macOS는 ZIP의 압축을 푼 뒤 앱을 실행합니다.

- [Windows Wi-Fi 설정 도구 (x64)](tools/setup_wifi_gui_windows.exe)
- [macOS Wi-Fi 설정 도구 (Apple silicon)](tools/setup_wifi_gui_macos.zip)

  <img src="tools/screenshot/set_wifi_gui.png" width="400"/>

1. 멀티탭의 전원 버튼을 **10초 이상** 길게 눌러 설정 모드로 전환합니다.
2. PC의 Wi-Fi 목록에서 `TONLY_TAP_xxxxxxx`에 연결합니다. 비밀번호는 `LGU_xxxxxxx`이며, `xxxxxxx` 부분은 Wi-Fi 이름에 표시된 문자와 동일하게 입력합니다. 이 Wi-Fi에서 인터넷에 연결되지 않는 것은 정상입니다.
3. Wi-Fi 설정 도구를 실행하고 **공유기 Wi-Fi SSID**, **Wi-Fi 비밀번호**, **Bridge 서버 IPv4**를 입력합니다. 서버 주소에는 `192.168.1.100`처럼 IP만 입력하며, `http://`나 `:8086`은 붙이지 않습니다.
4. **Wi-Fi 설정 시작**을 누르고 도구의 완료 안내를 확인합니다.
5. PC를 원래 Wi-Fi로 다시 연결한 뒤 브리지 대시보드를 엽니다.

멀티탭이 연결되면 잠시 후 대시보드의 기기 목록에 표시됩니다.

## 4. Matter 앱에 추가하기

1. 브리지 대시보드를 열고 **Matter 연결** 영역의 QR 코드를 확인합니다.
2. 사용하는 Matter 앱에서 기기 추가를 선택하고 QR 코드를 스캔합니다.
3. 앱의 안내에 따라 등록을 완료합니다.

## 펌웨어 업데이트

이 브릿지는 순정 기본 펌웨어에서도 동작하지만, 커스텀 펌웨어등을 사용하려면 이 도구를 활용할 수 있습니다.
펌웨어 파일은 별도로 준비해야 합니다.

- [Windows OTA 도구 (x64)](tools/ota_gui_windows.exe)
- [macOS OTA 도구 (Apple silicon)](tools/ota_gui_macos.zip)

  <img src="tools/screenshot/ota_gui.png" width="500"/>
