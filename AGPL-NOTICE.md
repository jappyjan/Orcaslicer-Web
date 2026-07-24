# AGPL notice

## What is shipped

The container image built from this repository bundles an **unmodified official release
binary of OrcaSlicer**, which is licensed under the **GNU Affero General Public License,
version 3 or later (AGPL-3.0-or-later)**.

|                  |                                                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------------- |
| Program          | OrcaSlicer                                                                                                            |
| Version          | **2.4.2**                                                                                                             |
| Upstream project | https://github.com/SoftFever/OrcaSlicer                                                                               |
| Release page     | https://github.com/SoftFever/OrcaSlicer/releases/tag/v2.4.2                                                           |
| Binary artefact  | `OrcaSlicer_Linux_AppImage_Ubuntu2404_V2.4.2.AppImage`                                                                |
| Download URL     | https://github.com/SoftFever/OrcaSlicer/releases/download/v2.4.2/OrcaSlicer_Linux_AppImage_Ubuntu2404_V2.4.2.AppImage |
| SHA-256          | `d12fb8c8eac1aecd2dfb6377acd48f994f8fa439ed5292fa532dd82880f029fd`                                                    |
| Licence          | AGPL-3.0-or-later (`LICENSE` in the upstream repository)                                                              |

The version and the checksum are pinned in the `Dockerfile` as `ARG ORCA_VERSION` and
`ARG ORCA_APPIMAGE_SHA256`. Those two values are the single source of truth; this file
must be updated whenever they change.

Alongside the binary, the image contains OrcaSlicer's `resources/` tree (printer,
process and filament profiles, shaders, fonts and related data files) as extracted from
that same AppImage. GUI-only resources are deleted during the image build; nothing is
altered.

## Where to get the corresponding source

The complete corresponding source for the shipped binary is the upstream Git tag:

```
git clone https://github.com/SoftFever/OrcaSlicer.git
cd OrcaSlicer
git checkout v2.4.2
```

Source archives for the same tag are also published on the release page linked above
("Source code (tar.gz)" / "Source code (zip)").

Because the binary we ship is byte-for-byte the artefact published by the upstream
project at that tag, that tag _is_ the corresponding source. This project applies no
patches, carries no vendored copy of the OrcaSlicer sources, and produces no derivative
build of them.

## Process-boundary rationale

This project is **not** a fork of OrcaSlicer and does **not** link against `libslic3r`
or any other OrcaSlicer library.

- OrcaSlicer is invoked as a **separate operating-system process** via its documented
  command-line interface (`orca-slicer --slice ... --export-3mf ...`).
- Communication is limited to arm's-length mechanisms: process arguments, files on
  disk, exit status, stdout/stderr, and the progress FIFO that upstream provides for
  this purpose (`--pipe`).
- No OrcaSlicer code is compiled into, statically linked into, dynamically linked
  against, or otherwise combined with this project's code. No OrcaSlicer headers are
  included and no internal APIs are called.
- The binary is used exactly as published. The image build downloads it, verifies its
  checksum, extracts the AppImage and puts it on `PATH`. It is never patched or rebuilt.

This is the same relationship any user has with a program they run from a shell, and it
is a deliberate architectural constraint of this project (see "Hard constraints" in
`docs/SPEC.md`) rather than a licensing convenience: keeping the boundary at a process
also means upstream upgrades are a version bump instead of a rebase.

Aggregating an AGPL program with separate programs on the same storage medium or in the
same container image does not make the other programs derivative works; see section 5
("Conveying Modified Source Versions", final paragraph on aggregates) of the GPL/AGPL.

## Obligations we honour

- The AGPL text and the copyright notices distributed inside the OrcaSlicer AppImage are
  preserved as-is in the image.
- This file, which states the exact version shipped and where to obtain its
  corresponding source, is distributed with the project and should also be reachable
  from any deployed instance's UI.
- If the shipped OrcaSlicer binary is ever replaced with a modified build, the modified
  source must be published and this notice rewritten. **Do not do this** — the whole
  design assumes an unmodified upstream binary.

## This project's own licence

The code in this repository is licensed **AGPL-3.0-or-later** as well, which keeps the
combined distribution unambiguous and avoids any argument about where the boundary
actually falls.
