#!/usr/bin/env python3
import os
import sys

# Ensure package directory is on pythonpath
pkg_dir = os.path.dirname(os.path.abspath(__file__))
if pkg_dir not in sys.path:
    sys.path.insert(0, pkg_dir)

from webpipe.cli import main

if __name__ == "__main__":
    main()
