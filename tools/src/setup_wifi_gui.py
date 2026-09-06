import queue
import re
import socket
import threading
from pathlib import Path
import tkinter as tk
from tkinter import messagebox, ttk
from tkinter.scrolledtext import ScrolledText

DEVICE = "192.168.1.1"
PORT = 30300
IPV4 = (
    r"(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}"
    r"(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])"
)


def configure(ssid, password, controller_ip, events):
    try:
        for attempt in range(4):
            events.put(("log", f"[접속] {DEVICE}:{PORT} (시도 {attempt + 1}/4)"))
            try:
                sock = socket.create_connection((DEVICE, PORT), timeout=5)
                break
            except OSError as exc:
                if attempt == 3:
                    raise OSError("TCP 소켓 접속 실패: 3회 재시도 모두 실패했습니다. "
                                  "멀티탭 WiFi에 PC를 연결 후 다시 시도해주세요.") from exc
                events.put(("log", f"[재시도 {attempt + 1}/3] {exc}"))

        with sock:
            commands = []
            if controller_ip:
                commands.append((f"up:ip:{controller_ip}", "Bridge 서버 설정"))
            commands.extend([
                (f"up:connect:{ssid}:{password}", "Wi-Fi 연결 설정"),
                ("up:reboot:0", "재부팅 요청"),
            ])
            for command, label in commands:
                events.put(("log", f"[전송] {label}"))
                sock.sendall((command + "\r\n").encode())
                response = sock.recv(1024)
                events.put(("log", f"[수신] {label}: {len(response)}바이트"))
        events.put(("done", "설정 정보 전송이 완료되었습니다."))
    except OSError as exc:
        events.put(("error", str(exc)))


def main():
    root = tk.Tk()
    icon = tk.PhotoImage(file=str(Path(__file__).resolve().parent / "icons" / "setup_wifi.png"))
    root.iconphoto(True, icon)
    root.title("LG MTTL-W01 Wi-Fi 설정")
    root.minsize(580, 540)
    frame = ttk.Frame(root, padding=20)
    frame.pack(fill="both", expand=True)
    frame.columnconfigure(1, weight=1)
    frame.rowconfigure(8, weight=1)

    ttk.Label(frame, text="LG MTTL-W01 멀티탭 Wi-Fi 설정",
              font=("", 16, "bold")).grid(row=0, column=0, columnspan=2, sticky="w", pady=(0, 16))
    ttk.Label(frame, text=(
        "1. 멀티탭 전원 버튼을 10초 이상 길게 누르세요.\n"
        "2. 이 PC를 멀티탭 Wi-Fi에 연결하세요.\n"
        "   SSID: TONLY_TAP_xxxxxxx / PW: LGU_xxxxxxx\n"
        "   xxxxxxx는 멀티탭 SSID에 표시된 고유 문자입니다.\n"
        "3. 아래에 공유기 Wi-Fi와 Bridge 서버 정보를 입력하세요."
    ), justify="left").grid(row=1, column=0, columnspan=2, sticky="w", pady=(0, 16))

    entries = []
    for row, label in enumerate(("공유기 Wi-Fi SSID", "Wi-Fi 비밀번호", "Bridge 서버 IPv4"), 2):
        ttk.Label(frame, text=label).grid(row=row, column=0, sticky="w", padx=(0, 12), pady=6)
        entry = ttk.Entry(frame, show="*" if row == 3 else "")
        entry.grid(row=row, column=1, sticky="ew", pady=6)
        entries.append(entry)

    show_password = tk.BooleanVar()
    ttk.Checkbutton(frame, text="비밀번호 표시", variable=show_password,
                    command=lambda: entries[1].configure(show="" if show_password.get() else "*")
                    ).grid(row=5, column=1, sticky="w")
    status = tk.StringVar(value="멀티탭 Wi-Fi에 PC를 연결한 뒤 설정을 시작하세요.")
    ttk.Label(frame, textvariable=status).grid(row=7, column=0, columnspan=2, sticky="w", pady=8)
    log = ScrolledText(frame, height=10, width=64, state="disabled", wrap="word")
    log.grid(row=8, column=0, columnspan=2, sticky="nsew")
    events = queue.Queue()

    def start():
        ssid, password, controller_ip = [entry.get() for entry in entries]
        if not ssid or any("\r" in value or "\n" in value for value in (ssid, password)):
            messagebox.showerror("입력 확인", "SSID를 입력해주세요.", parent=root)
            return
        if not re.fullmatch(IPV4, controller_ip):
            if not messagebox.askyesno(
                "IP 주소 확인", "잘못된 IP주소입니다. Bridge서버 설정 없이 Wifi 연결하시겠습니까?",
                default=messagebox.NO, parent=root,
            ):
                return
            controller_ip = ""
        button.configure(state="disabled")
        for entry in entries:
            entry.configure(state="disabled")
        status.set("설정 중…")
        threading.Thread(target=configure, args=(ssid, password, controller_ip, events), daemon=True).start()

    def poll():
        try:
            while True:
                kind, text = events.get_nowait()
                log.configure(state="normal")
                log.insert("end", text + "\n")
                log.see("end")
                log.configure(state="disabled")
                if kind in ("done", "error"):
                    button.configure(state="normal")
                    for entry in entries:
                        entry.configure(state="normal")
                    status.set("설정 완료" if kind == "done" else "설정 실패")
                    dialog = messagebox.showinfo if kind == "done" else messagebox.showerror
                    dialog(status.get(), text, parent=root)
        except queue.Empty:
            pass
        root.after(100, poll)

    button = ttk.Button(frame, text="Wi-Fi 설정 시작", command=start)
    button.grid(row=6, column=0, columnspan=2, sticky="ew", pady=(16, 0))
    entries[0].focus_set()
    root.after(100, poll)
    root.mainloop()


if __name__ == "__main__":
    main()
