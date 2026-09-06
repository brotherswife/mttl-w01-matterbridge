import re
import socket

DEVICE = "192.168.1.1"
PORT = 30300

def command(sock, cmd):
    data = (cmd + "\r\n").encode()

    print(f"[전송] {data!r}")
    sock.sendall(data)

    response = sock.recv(1024)
    print(f"[수신] {response!r}")

print("=" * 50)
print("LG MTTL-W01 멀티탭 Wi-Fi 설정")
print("=" * 50)
print("\n[1/3] 멀티탭 Wi-Fi 연결")
print("기기의 전원 버튼을 10초 이상 길게 누르면 잠시 후 TONLY_TAP_xxxxxxx와 같은 WiFi를 확인할 수 있습니다.")
print("현재 스크립트를 실행 중인 PC에서 TONLY_TAP_xxxxxxx WiFi에 접속 후 엔터키를 눌러주세요.\n")
print("SSID: TONLY_TAP_xxxxxxx (xxxxxxx는 기기 고유의 영문자 또는 숫자입니다.)")
print("PW: LGU_xxxxxxx (xxxxxxx는 SSID에 표시되는 고유 문자로 입력해주세요.)")
input()

print('\n[2/3] 멀티탭이 접속할 Wi-Fi 정보를 입력해주세요. (공유기 WiFi 정보를 입력하셔야 합니다.)\n')
wifi_ssid = input('SSID: ')
wifi_pw = input('PW: ')

print("\n[3/3] MTTL-W01 MatterBridge 서버 IP 주소를 입력해주세요.\n")
controller_ip = input('IP: ')
if not re.fullmatch(
    r"(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}"
    r"(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])",
    controller_ip,
):
    answer = input("잘못된 IP주소입니다. Bridge서버 설정 없이 Wifi 연결하시겠습니까? [y/N]: ")
    if answer.strip().lower() not in ("y", "yes"):
        print("[취소] Wi-Fi 설정을 취소했습니다.")
        raise SystemExit(0)
    controller_ip = ""

print("\n멀티탭으로 설정 정보를 전송합니다.")

for attempt in range(4):
    print(f"[접속] {DEVICE}:{PORT} (시도 {attempt + 1}/4)")
    try:
        s = socket.create_connection((DEVICE, PORT), timeout=5)
        break
    except OSError as exc:
        if attempt == 3:
            print(f"[실패] TCP 소켓 접속 실패: 3회 재시도 모두 실패했습니다. 멀티탭 WiFi에 PC를 연결 후 다시 시도해주세요. ({exc})")
            raise SystemExit(1)
        print(f"[재시도 {attempt + 1}/3] TCP 소켓 접속 실패: {exc}")

print("[연결됨] 멀티탭으로 설정 정보를 전송합니다.")
with s:
    command(s, f"up:ip:{controller_ip}")
    command(s, f"up:connect:{wifi_ssid}:{wifi_pw}")
    command(s, f"up:reboot:0")
    print("[완료] 설정이 완료되었습니다.")
