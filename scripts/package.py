#!/usr/bin/env python3
"""Validate and package the unpacked extension without local test artifacts."""
import json
from pathlib import Path
import zipfile

root = Path(__file__).resolve().parents[1]
extension = root / 'extension'
manifest = json.loads((extension / 'manifest.json').read_text(encoding='utf-8'))
package = json.loads((root / 'package.json').read_text(encoding='utf-8'))
assert manifest['manifest_version'] == 3
assert manifest['version'] == package['version'], 'Version mismatch'
assert set(manifest['permissions']) == {'tabs', 'storage', 'contextMenus'}
assert not manifest.get('host_permissions')
assert not manifest.get('content_scripts')
files = ['manifest.json', 'core.js', 'background.js', 'popup.html', 'popup.css', 'popup.js']
assert manifest['background']['service_worker'] in files
assert manifest['action']['default_popup'] in files
for name in files:
    assert (extension / name).is_file(), f'Missing: {name}'

dist = root / 'dist'
dist.mkdir(exist_ok=True)
archive = dist / f"tab-reuse-{manifest['version']}.zip"
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as output:
    for name in sorted(files):
        output.write(extension / name, Path('tab-reuse') / name)
print(archive)
