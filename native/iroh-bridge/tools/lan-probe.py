import json, os, socket, subprocess, sys, threading, time
b = sys.argv[1]
p = subprocess.Popen([b, '--bridge-port', '0', '--mdns'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
threading.Thread(target=lambda: [print('STDERR', l.rstrip(), flush=True) for l in p.stderr], daemon=True).start()
port = json.loads(p.stdout.readline())['bridgePort']
def req(o):
    s = socket.create_connection(('127.0.0.1', port)); s.sendall((json.dumps(o) + '\n').encode()); f = s.makefile('rb'); return s, f, f.readline()
_, ev, _ = req({'op': 'control'})
threading.Thread(target=lambda: [print('EVENT', l.decode().rstrip()[:200], flush=True) for l in ev], daemon=True).start()
_, _, r = req({'op': 'lan-start', 'session': 'lan', 'secret': os.urandom(32).hex(), 'userData': '{"n":"probe"}'})
print('lan-start ->', r.decode().strip()[:200], flush=True)
time.sleep(int(sys.argv[2]) if len(sys.argv) > 2 else 20)
print('pid', p.pid, flush=True)
p.kill()
