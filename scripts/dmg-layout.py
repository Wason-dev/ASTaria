"""Write only a mounted staging volume's Finder layout; never drive Finder UI.

Build-only dependencies: ds_store 1.3.1 and mac_alias 2.2.2. A task-specific
module directory can be supplied with ASTARIA_DMG_LAYOUT_MODULES.
"""
import json
import os
from pathlib import Path
import sys

if os.environ.get('ASTARIA_DMG_LAYOUT_MODULES'):
    sys.path.insert(0, os.environ['ASTARIA_DMG_LAYOUT_MODULES'])
from ds_store import DSStore
from mac_alias import Alias, Bookmark

volume = Path(sys.argv[1]).resolve(strict=True)
background = volume / '.background' / 'install.png'
if not volume.is_dir() or not background.is_file() or not (volume / 'ASTaria.app').is_dir():
    raise ValueError('Expected a mounted ASTaria staging volume')
settings = dict(viewOptionsVersion=1, backgroundType=2,
                backgroundColorRed=0.03, backgroundColorGreen=0.04, backgroundColorBlue=0.055,
                backgroundImageAlias=Alias.for_file(str(background)).to_bytes(),
                iconSize=112.0, textSize=13.0, labelOnBottom=True, showItemInfo=False,
                showIconPreview=False, arrangeBy='none', gridSpacing=100.0,
                gridOffsetX=0.0, gridOffsetY=0.0, scrollPositionX=0.0, scrollPositionY=0.0)
with DSStore.open(str(volume / '.DS_Store'), 'w+') as store:
    store['.']['bwsp'] = dict(ShowToolbar=False, ShowStatusBar=False, ShowSidebar=False,
                             ShowTabView=False, ShowPathbar=False, ContainerShowSidebar=False,
                             PreviewPaneVisibility=False, WindowBounds='{{180, 100}, {900, 560}}')
    store['.']['icvp'] = settings
    store['.']['vSrn'] = ('long', 1)
    store['.']['icvl'] = ('type', b'icnv')
    store['.']['pBBk'] = Bookmark.for_file(str(background))
    store['ASTaria.app']['Iloc'] = (274, 248)
    store['Applications']['Iloc'] = (626, 248)
    store['安装与打开说明.txt']['Iloc'] = (764, 450)
with DSStore.open(str(volume / '.DS_Store'), 'r') as store:
    assert store['ASTaria.app']['Iloc'] == (274, 248)
    assert store['Applications']['Iloc'] == (626, 248)
    assert store['安装与打开说明.txt']['Iloc'] == (764, 450)
    assert store['.']['icvp']['backgroundType'] == 2
    assert store['.']['bwsp']['WindowBounds'] == '{{180, 100}, {900, 560}}'
print(json.dumps({'status': 'passed', 'window': [900, 560], 'background': '.background/install.png',
                  'icons': {'ASTaria.app': [274, 248], 'Applications': [626, 248], '安装与打开说明.txt': [764, 450]}}))
