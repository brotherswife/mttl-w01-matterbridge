#!/usr/bin/env python3
"""MTTL-W01 local OTA GUI; serves the selected firmware without conversion."""
import http.server
import base64
import json
import os
import queue
import secrets
import shlex
import socket
import socketserver
import subprocess
import sys
import threading
import time
from pathlib import Path

DEVICE = "192.168.1.1"
PORT = 30300
OTA_PORT = 80


def helper_command(port, token):
    if "__compiled__" in globals():
        # Nuitka's sys.executable can point to a nonexistent bundled Python.
        # argv[0] is the actual app executable, including when Finder launches it.
        argv = [str(Path(sys.argv[0]).resolve())]
    else:
        argv = [sys.executable, str(Path(__file__).resolve())]
    argv.extend(["--ota-http-helper", str(port), token])
    return [
        "/usr/bin/osascript", "-e",
        'on run argv\n'
        'do shell script (item 1 of argv) with administrator privileges '
        'with prompt "MTTL-W01 OTA의 HTTP 80번 서버를 실행하기 위해 관리자 권한이 필요합니다."\n'
        'end run',
        shlex.join(argv),
    ]


def send_message(stream, message):
    stream.write(json.dumps(message).encode("utf-8") + b"\n")
    stream.flush()


class AdminHttpServer:
    """Only the HTTP child is elevated; firmware bytes come from the user GUI."""

    def __init__(self, address, data, events, stop, timeout):
        self.done = threading.Event()
        self.error = None
        self.connection = None
        self.process = None
        self.reader = None
        token = secrets.token_hex(32)
        try:
            with socket.socket() as listener:
                listener.bind(("127.0.0.1", 0))
                listener.listen(1)
                listener.settimeout(0.2)
                self.process = subprocess.Popen(
                    helper_command(listener.getsockname()[1], token),
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                events.put(("log", "[권한] HTTP 서버 시작을 위한 관리자 인증 대기"))
                deadline = time.monotonic() + 120
                while True:
                    if self.process.poll() is not None:
                        _, error = self.process.communicate()
                        raise OSError("관리자 인증이 취소되었거나 HTTP 서버 실행에 실패했습니다.\n" + error.strip())
                    if stop.is_set() or time.monotonic() >= deadline:
                        raise TimeoutError("HTTP 서버 관리자 인증 대기 시간이 초과되었습니다.")
                    try:
                        connection, _ = listener.accept()
                    except socket.timeout:
                        continue
                    connection.settimeout(5)
                    stream = connection.makefile("rwb")
                    try:
                        authenticated = json.loads(stream.readline(1024)) == token
                    except (OSError, ValueError):
                        authenticated = False
                    if authenticated:
                        self.connection, self.stream = connection, stream
                        break
                    stream.close()
                    connection.close()
                send_message(self.stream, {
                    "ip": address[0], "data": base64.b64encode(data).decode("ascii"),
                    "timeout": timeout,
                })
                kind, message = json.loads(self.stream.readline())
                if kind != "ready":
                    raise OSError(message)
                self.connection.settimeout(None)
            self.reader = threading.Thread(target=self.read_events, args=(events,), daemon=True)
            self.reader.start()
        except BaseException:
            self.server_close()
            raise

    def read_events(self, events):
        try:
            for line in self.stream:
                kind, message = json.loads(line)
                if kind == "finished":
                    self.error = message
                    return
                events.put((kind, message))
            self.error = "HTTP 서버와의 연결이 끊어졌습니다."
        except (OSError, ValueError) as exc:
            self.error = f"HTTP 서버 통신 실패: {exc}"
        finally:
            self.done.set()

    def server_close(self):
        # EOF is also the child's stop signal if the GUI exits unexpectedly.
        if self.connection is not None:
            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            if self.reader is not None:
                self.reader.join(timeout=5)
            self.stream.close()
            self.connection.close()
        if self.process is not None:
            try:
                self.process.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.terminate()
                self.process.communicate()


def run_http_helper(port, token):
    """Headless child: no Tk window and no access to the user's firmware path."""
    with socket.create_connection(("127.0.0.1", port), timeout=10) as connection:
        with connection.makefile("rwb") as stream:
            send_message(stream, token)
            config = json.loads(stream.readline())
            connection.settimeout(None)
            events, stop = queue.Queue(), threading.Event()
            try:
                data = base64.b64decode(config["data"], validate=True)
                if not data:
                    raise ValueError("OTA 파일이 비어 있습니다.")
                server = OtaServer((config["ip"], OTA_PORT), data, events, stop)
            except (OSError, ValueError) as exc:
                send_message(stream, ("error", f"HTTP 80번 포트를 열 수 없습니다: {exc}"))
                return
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()

            def watch_parent():
                try:
                    connection.recv(1)
                except OSError:
                    pass
                stop.set()

            threading.Thread(target=watch_parent, daemon=True).start()
            try:
                send_message(stream, ("ready", None))
                deadline = time.monotonic() + config["timeout"] + 10
                while not stop.is_set():
                    try:
                        send_message(stream, events.get(timeout=0.1))
                    except queue.Empty:
                        if server.done.is_set():
                            send_message(stream, ("finished", server.error))
                            break
                    if time.monotonic() >= deadline:
                        send_message(stream, ("finished", "HTTP 서버 대기/전송 시간이 초과되었습니다."))
                        break
            finally:
                stop.set()
                server.shutdown()
                thread.join()
                server.server_close()


class OtaServer(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def server_bind(self):
        # SoftAP may have no DNS; avoid HTTPServer's blocking reverse lookup.
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address

    def __init__(self, address, data, events, stop):
        self.data = data
        self.events = events
        self.stop = stop
        self.done = threading.Event()
        self.error = None
        super().__init__(address, OtaHandler)


class OtaHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        self.server.events.put(("log", "[HTTP] " + fmt % args))

    def do_GET(self):
        if self.path != "/ota.bin":
            self.send_error(404)
            return
        server = self.server
        sent = 0
        self.connection.settimeout(5)
        try:
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(server.data)))
            self.send_header("Connection", "close")
            self.end_headers()
            # Preserve the reference tool's pacing for the device's small buffers.
            for offset in range(0, len(server.data), 512):
                if server.stop.is_set():
                    raise OSError("HTTP 서버가 종료되었습니다.")
                chunk = server.data[offset:offset + 512]
                self.wfile.write(chunk)
                self.wfile.flush()
                sent += len(chunk)
                if sent % 65536 == 0 or sent == len(server.data):
                    server.events.put(("progress", sent * 100 / len(server.data)))
                    server.events.put(("log", f"[전송] {sent:,}/{len(server.data):,} 바이트"))
                time.sleep(0.005)
        except OSError as exc:
            server.error = f"HTTP 전송 실패 ({sent:,}/{len(server.data):,} 바이트): {exc}"
        finally:
            self.close_connection = True
            server.done.set()


def run_ota(filename, events, stop, timeout=90):
    server = None
    thread = None
    result = ("error", "OTA를 시작하지 못했습니다.")
    try:
        data = Path(filename).read_bytes()
        if not data:
            raise ValueError("OTA 파일이 비어 있습니다.")
        # Select the route without keeping a device TCP session open during authentication.
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as route:
            route.connect((DEVICE, PORT))
            local_ip = route.getsockname()[0]
        try:
            if sys.platform == "darwin" and os.geteuid() != 0:
                server = AdminHttpServer((local_ip, OTA_PORT), data, events, stop, timeout)
            else:
                server = OtaServer((local_ip, OTA_PORT), data, events, stop)
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
        except OSError as exc:
            raise OSError(f"HTTP 서버를 시작하지 못했습니다. ({exc})") from exc
        events.put(("log", f"[서버] http://{local_ip}/ota.bin ({len(data):,} 바이트)"))
        with socket.create_connection((DEVICE, PORT), timeout=5) as sock:
            events.put(("log", f"[연결] {DEVICE}:{PORT} / PC IP: {local_ip}"))
            if stop.is_set():
                raise OSError("HTTP 서버가 종료되었습니다.")
            command = f"up:ota:{local_ip}\r\n"
            sock.sendall(command.encode("ascii"))
            events.put(("log", f"[TCP 전송] {command.strip()}"))
            response = b""
            deadline = time.monotonic() + 5
            while b"\n" not in response and len(response) < 4096:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                sock.settimeout(remaining)
                try:
                    chunk = sock.recv(1024)
                except socket.timeout:
                    break
                if not chunk:
                    break
                response += chunk
            reply = response.decode("utf-8", "replace").strip("\x00\r\n ")
            events.put(("log", f"[TCP 수신] {reply or '(응답 없음)'}"))
            if "up:ota:ota_ok" not in reply:
                raise OSError("OTA 승인 응답(up:ota:ota_ok)을 받지 못했습니다.")

        events.put(("log", f"[대기] 장치 다운로드 대기 (최대 {timeout}초)"))
        deadline = time.monotonic() + timeout
        while not server.done.wait(0.1):
            if stop.is_set():
                raise OSError("HTTP 서버가 종료되었습니다.")
            if time.monotonic() >= deadline:
                raise TimeoutError("다운로드 대기/전송 시간이 초과되었습니다. 멀티탭 Wi-Fi 연결과 "
                                   "Windows 방화벽의 Python TCP 80 인바운드 허용을 확인하세요.")
        if server.error:
            raise OSError(server.error)
        result = ("done", "파일 전송 완료. 전원 LED 깜빡임이 멈추면 Wifi연결 설정을 다시 진행해주세요.")
    except (OSError, ValueError) as exc:
        result = ("error", str(exc))
    finally:
        stop.set()
        if server is not None:
            if thread is not None:
                server.shutdown()
                thread.join()
            server.server_close()
            events.put(("log", "[서버] 임시 HTTP 서버 종료"))
        events.put(result)


def main():
    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk
    from tkinter.scrolledtext import ScrolledText

    root = tk.Tk()
    icon = tk.PhotoImage(file=str(Path(__file__).resolve().parent / "icons" / "ota.png"))
    root.iconphoto(True, icon)
    root.title("LG MTTL-W01 OTA 업데이트")
    frame = ttk.Frame(root, padding=20)
    frame.pack(fill="both", expand=True)
    frame.columnconfigure(0, weight=1)
    frame.rowconfigure(6, weight=1)
    ttk.Label(frame, text="LG MTTL-W01 OTA 업데이트", font=("", 16, "bold")).grid(
        row=0, column=0, columnspan=2, sticky="w", pady=(0, 16))
    ttk.Label(frame, text=(
        "1. 멀티탭을 설정 모드로 전환하고 이 PC를 멀티탭 Wi-Fi에 연결하세요.\n"
        "   SSID: TONLY_TAP_xxxxxxx / 비밀번호: LGU_xxxxxxx\n"
        "2. 이 장치에 맞는 OTA 파일을 선택한 뒤 업데이트를 시작하세요.\n"
        "   방화벽 수신(TCP 80포트) 연결을 허용해야 합니다.\n"
        "   업데이트 중에는 멀티탭 전원을 끄지 마세요."
    ), justify="left").grid(row=1, column=0, columnspan=2, sticky="w", pady=(0, 12))
    filename = tk.StringVar()
    entry = ttk.Entry(frame, textvariable=filename, width=65, state="readonly")
    entry.grid(row=2, column=0, sticky="ew")
    events = queue.Queue()
    stop = threading.Event()
    worker = None

    def choose():
        path = filedialog.askopenfilename(parent=root, title="OTA 파일 선택", filetypes=[
            ("OTA 펌웨어", "*.fwr *.bin"), ("모든 파일", "*")])
        if path:
            filename.set(path)

    def start():
        nonlocal worker
        if not Path(filename.get()).is_file():
            messagebox.showerror("파일 확인", "OTA 파일을 선택하세요.", parent=root)
            return
        stop.clear()
        choose_button.configure(state="disabled")
        start_button.configure(state="disabled")
        progress["value"] = 0
        status.set("OTA 진행 중…")
        worker = threading.Thread(target=run_ota, args=(filename.get(), events, stop), daemon=True)
        worker.start()

    def close():
        if worker is not None and worker.is_alive():
            messagebox.showinfo("OTA 진행 중", "전송이 끝난 뒤 창을 닫아주세요.", parent=root)
            return
        root.destroy()

    def poll():
        try:
            while True:
                kind, text = events.get_nowait()
                if kind == "progress":
                    progress["value"] = text
                    continue
                log.configure(state="normal")
                log.insert("end", text + "\n")
                log.see("end")
                log.configure(state="disabled")
                if kind in ("done", "error"):
                    choose_button.configure(state="normal")
                    start_button.configure(state="normal")
                    status.set("파일 전송 완료" if kind == "done" else "전송 실패")
                    dialog = messagebox.showinfo if kind == "done" else messagebox.showerror
                    dialog(status.get(), text, parent=root)
        except queue.Empty:
            pass
        root.after(100, poll)

    choose_button = ttk.Button(frame, text="파일 선택…", command=choose)
    choose_button.grid(row=2, column=1, padx=(8, 0))
    start_button = ttk.Button(frame, text="OTA 업데이트 시작", command=start)
    start_button.grid(row=3, column=0, columnspan=2, sticky="ew", pady=12)
    progress = ttk.Progressbar(frame, maximum=100)
    progress.grid(row=4, column=0, columnspan=2, sticky="ew")
    status = tk.StringVar(value="멀티탭 Wi-Fi 연결 후 OTA 파일을 선택하세요.")
    ttk.Label(frame, textvariable=status).grid(row=5, column=0, columnspan=2, sticky="w", pady=8)
    log = ScrolledText(frame, height=12, width=72, state="disabled", wrap="word")
    log.grid(row=6, column=0, columnspan=2, sticky="nsew")
    root.protocol("WM_DELETE_WINDOW", close)
    root.after(100, poll)
    root.mainloop()


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--ota-http-helper":
        run_http_helper(int(sys.argv[2]), sys.argv[3])
    else:
        main()
