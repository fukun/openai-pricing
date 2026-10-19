import base64
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from email.message import Message
import zipfile

spec = importlib.util.spec_from_file_location('offline_archive', Path(__file__).resolve().parents[1] / 'offline_archive.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Response(io.BytesIO):
    def __init__(self, url, content, mime):
        super().__init__(content)
        self.url = url
        self.headers = Message()
        self.headers['Content-Type'] = mime


class OfflineTests(unittest.TestCase):
    def test_nested_styles_fonts_images_and_zip_are_self_contained(self):
        resources = {
            '/style.css': (b'@import "nested.css";body{background:url("/bg.png")}', 'text/css'),
            '/nested.css': (b'@font-face{src:url("/font.woff2")}', 'text/css'),
            '/font.woff2': (b'font', 'font/woff2'),
            '/bg.png': (b'background', 'image/png'),
            '/logo.svg': (b'<svg/>', 'image/svg+xml'),
        }
        def fetch(request, **kwargs):
            path = module.urllib.parse.urlsplit(request.full_url).path
            content, mime = resources[path]
            return Response(request.full_url, content, mime)
        with tempfile.TemporaryDirectory() as directory, patch.object(module.urllib.request, 'urlopen', side_effect=fetch):
            root = Path(directory)
            sources = root / 'data/deepseek/sources'
            sources.mkdir(parents=True)
            source = sources / 'test.html.txt'
            source.write_text('<!doctype html><html><head><link rel="stylesheet" href="/style.css"><script src="/app.js"></script></head><body onload="bad()"><article><img src="/logo.svg" srcset="/remote.svg 2x"><table><tr><td>$0.15</td></tr></table></article></body></html>')
            module.build_all(root)
            output = root / 'data/deepseek/offline/test.html'
            page = output.read_text()
            self.assertNotIn('<script', page)
            self.assertNotIn('onload', page)
            self.assertNotIn('srcset', page)
            self.assertIn('href="data:text/css;base64,', page)
            self.assertIn('src="data:image/svg+xml;base64,', page)
            css = base64.b64decode(page.split('href="data:text/css;base64,')[1].split('"')[0]).decode()
            self.assertIn('data:text/css;base64,', css)
            self.assertIn('data:image/png;base64,', css)
            with zipfile.ZipFile(output.with_suffix('.zip')) as bundle:
                self.assertEqual(bundle.read('index.html'), output.read_bytes())
                self.assertEqual(set(bundle.namelist()), {'index.html', 'manifest.json', 'README.txt'})
            # Completed copies never fetch newer versions of historical resources.
            with patch.object(module.urllib.request, 'urlopen', side_effect=AssertionError('unexpected refresh')):
                module.build_all(root)

    def test_missing_resource_does_not_publish_partial_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sources = root / 'data/deepseek/sources'
            sources.mkdir(parents=True)
            (sources / 'test.html.txt').write_text('<img src="/missing.png">')
            with patch.object(module.urllib.request, 'urlopen', side_effect=OSError('unavailable')):
                with self.assertRaises(RuntimeError):
                    module.build_all(root)
            self.assertEqual(list((root / 'data/deepseek/offline').iterdir()), [])


if __name__ == '__main__':
    unittest.main()
