"""musterd's CooperBench arms. Importing the package (COOPERBENCH_EXTERNAL_AGENTS) also pins the
container's local `main` to the task base for every arm, theirs included (pin_main.py)."""

from .pin_main import install_pin_main

install_pin_main()
