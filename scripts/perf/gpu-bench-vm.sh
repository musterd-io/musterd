#!/usr/bin/env bash
# The capture A/B on a GPU host (lane 01M55MAQ9M): x11grab of an Xorg that runs on the NVIDIA driver,
# so Chrome can composite on the GPU. Xvfb has no GPU, which is why the Fly bench cannot ask this.
# Not spot: a spot L4 was preempted 11 minutes in (2026-10-17). Runs as root on a GCP `g2-standard-4` (NVIDIA L4) booted from Ubuntu's accelerator image:
#
#   gcloud compute instances create musterd-gpu-bench --project=<p> --zone=us-west1-a \
#     --machine-type=g2-standard-4 --instance-termination-action=DELETE \
#     --max-run-duration=2h --boot-disk-size=50GB \
#     --image-project=ubuntu-os-accelerator-images \
#     --image-family=ubuntu-accelerator-2404-amd64-with-nvidia-580
#   git archive --format=tar -o /tmp/src.tar HEAD
#   gcloud compute scp /tmp/src.tar scripts/perf/gpu-bench-vm.sh musterd-gpu-bench:/tmp/
#   gcloud compute ssh musterd-gpu-bench -- sudo bash /tmp/gpu-bench-vm.sh
#   … read /var/log/capture-ab.log for CAPTURE_AB lines, then delete the VM.
#
# The L4 has no display outputs, hence an empty initial configuration and a virtual 1080p screen.
# `UseDisplayDevice None` is refused on it ("not supported with virtual display", 2026-10-17).
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

# From the loaded module, not nvidia-smi: installing the Xorg driver swaps out the image's `-server`
# utils, and nvidia-smi goes with them (2026-10-17).
drv=$(grep -o 'Module for x86_64 *[0-9]*' /proc/driver/nvidia/version | grep -o '[0-9]*$')
apt-get update
apt-get install -y --no-install-recommends \
  "xserver-xorg-video-nvidia-${drv}" "libnvidia-gl-${drv}" "libnvidia-encode-${drv}" xserver-xorg-core \
  libegl1 libgles2 libglx0 libopengl0 x11-utils xauth \
  ffmpeg sqlite3 curl ca-certificates procps python3 make g++ fonts-dejavu-core fonts-liberation
curl -fsSLo /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
apt-get install -y /tmp/chrome.deb
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# lspci says `00:03.0` in hex; Xorg wants `PCI:0:3:0` in decimal.
IFS=':.' read -r bus dev fn <<<"$(lspci -d 10de: | awk '{print $1; exit}')"
cat >/etc/X11/xorg-bench.conf <<EOF
Section "Device"
  Identifier "nv"
  Driver "nvidia"
  BusID "PCI:$((16#$bus)):$((16#$dev)):$((16#$fn))"
  Option "AllowEmptyInitialConfiguration" "True"
EndSection
Section "Screen"
  Identifier "s"
  Device "nv"
  DefaultDepth 24
  SubSection "Display"
    Depth 24
    Virtual 1920 1080
  EndSubSection
EndSection
EOF
setsid Xorg :0 -config /etc/X11/xorg-bench.conf -noreset -nolisten tcp >/var/log/xorg-bench.log 2>&1 </dev/null &
sleep 3
DISPLAY=:0 xdpyinfo | grep -E 'dimensions|NV-GLX' || true

mkdir -p /opt/musterd && tar -xf /tmp/src.tar -C /opt/musterd
cd /opt/musterd
corepack enable
pnpm install --frozen-lockfile
pnpm build

export CHROME_BIN=/usr/bin/google-chrome CAPTURE_AB_DISPLAY=:0 CAPTURE_AB_FPS=30
export CAPTURE_AB_ARMS="${CAPTURE_AB_ARMS:-x11-adhoc~base#1,x11-adhoc~nvenc#1,x11-adhoc~nvenc+novsync#1,x11-adhoc~base#2,x11-adhoc~nvenc#2,x11-adhoc~nvenc+novsync#2}"
setsid bash scripts/perf/capture-ab.sh >/var/log/capture-ab.log 2>&1 </dev/null &
echo started
