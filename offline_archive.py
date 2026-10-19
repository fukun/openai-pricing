"""Build self-contained, script-free DeepSeek reading copies (stdlib only)."""
import base64
import hashlib
import html
from html.parser import HTMLParser
import json
import mimetypes
from pathlib import Path
import re
import tempfile
import os
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parent
SOURCE_URL = 'https://api-docs.deepseek.com/quick_start/pricing'
VERSION = 1


class Resources:
    def __init__(self):
        self.cache = {}
        self.active = set()
        self.records = []

    def embed(self, value, base, css=False):
        value = html.unescape(value.strip())
        if value.startswith('data:'):
            header, payload = value.split(',', 1)
            if ';base64' in header:
                return value
            mime = header[5:].split(';')[0] or 'text/plain'
            return f'data:{mime};base64,' + base64.b64encode(urllib.parse.unquote_to_bytes(payload)).decode('ascii')
        if not value or value.startswith('#'):
            return value
        url = urllib.parse.urljoin(base, value)
        parts = urllib.parse.urlsplit(url)
        if parts.scheme != 'https' or parts.hostname not in {
            'api-docs.deepseek.com', 'cdn.deepseek.com', 'fonts.googleapis.com', 'fonts.gstatic.com', 'raw.githubusercontent.com'
        }:
            raise ValueError(f'Unsupported resource URL: {url}')
        key = (url, css)
        if key in self.cache:
            return self.cache[key]
        if key in self.active:
            raise ValueError(f'Circular stylesheet import: {url}')
        self.active.add(key)
        print(f'Saving offline resource: {url}', flush=True)
        download_url = url
        headers = {'User-Agent': 'model-pricing-history/1.0'}
        if parts.hostname == 'raw.githubusercontent.com':
            owner, repo, ref, path = parts.path.strip('/').split('/', 3)
            download_url = f'https://api.github.com/repos/{owner}/{repo}/contents/{path}?ref={ref}'
            headers['Accept'] = 'application/vnd.github.raw+json'
        request = urllib.request.Request(download_url, headers=headers)
        with urllib.request.urlopen(request, timeout=45) as response:
            if urllib.parse.urlsplit(response.url).hostname not in {
                'api-docs.deepseek.com', 'cdn.deepseek.com', 'fonts.googleapis.com', 'fonts.gstatic.com', 'raw.githubusercontent.com', 'api.github.com'
            }:
                raise ValueError('Resource redirected to an unsupported host')
            content = response.read(15_000_001)
            mime = response.headers.get_content_type()
            if len(content) > 15_000_000:
                raise ValueError(f'Resource exceeds 15 MB: {url}')
            if css or mime == 'text/css':
                content = self.styles(content.decode('utf-8'), response.url).encode('utf-8')
                mime = 'text/css'
            elif mime == 'application/octet-stream' or parts.hostname == 'raw.githubusercontent.com':
                mime = mimetypes.guess_type(parts.path)[0] or mime
        encoded = f'data:{mime};base64,' + base64.b64encode(content).decode('ascii')
        self.cache[key] = encoded
        self.active.remove(key)
        self.records.append({'url': url, 'sha256': hashlib.sha256(content).hexdigest(), 'bytes': len(content)})
        return encoded

    def styles(self, text, base):
        # CSS imports become embedded stylesheets, including their own dependencies.
        text = re.sub(r'@import\s+([\'"])(.*?)\1',
                      lambda m: '@import url("' + self.embed(m[2], base, True) + '")', text, flags=re.I)
        text = re.sub(r'url\(\s*([\'"]?)(.*?)\1\s*\)',
                      lambda m: 'url("' + self.embed(m[2], base) + '")', text, flags=re.I)
        return text


class ReadingPage(HTMLParser):
    def __init__(self, resources):
        super().__init__(convert_charrefs=False)
        self.resources = resources
        self.parts = []
        self.skip = None
        self.in_style = False

    def handle_starttag(self, tag, attrs):
        if self.skip:
            return
        if tag in {'script', 'iframe', 'object', 'noscript'}:
            self.skip = tag
            return
        attrs = dict(attrs)
        if tag in {'base', 'embed'} or (tag == 'meta' and attrs.get('http-equiv', '').lower() in {'refresh', 'content-security-policy'}):
            return
        if tag == 'link':
            rel = attrs.get('rel', '').lower().split()
            if 'stylesheet' in rel:
                attrs['href'] = self.resources.embed(attrs.get('href', ''), SOURCE_URL, True)
            elif 'icon' in rel:
                attrs['href'] = self.resources.embed(attrs.get('href', ''), SOURCE_URL)
            else:
                return
        if tag == 'html':
            attrs.update({'data-theme': 'light'})
        for key, value in list(attrs.items()):
            if key.startswith('on') or key in {'srcset', 'imagesrcset', 'integrity', 'crossorigin', 'ping', 'action'}:
                del attrs[key]
            elif key in {'src', 'poster', 'background'} and value:
                attrs[key] = self.resources.embed(value, SOURCE_URL)
            elif key == 'style' and value:
                attrs[key] = self.resources.styles(value, SOURCE_URL)
            elif key in {'href', 'xlink:href'} and value and tag != 'link':
                attrs[key] = urllib.parse.urljoin(SOURCE_URL, value) if not value.startswith('#') else value
                if not attrs[key].startswith(('https:', '#', 'mailto:')):
                    del attrs[key]
        self.parts.append('<' + tag + ''.join(' ' + k + ('="' + html.escape(v, quote=True) + '"' if v is not None else '') for k, v in attrs.items()) + '>')
        if tag == 'head':
            self.parts.append('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\' data:; img-src data:; font-src data:; media-src data:; form-action \'none\'; base-uri \'none\'">')
            self.parts.append('<style>button{display:none!important}html{color-scheme:light}</style>')
        self.in_style = tag == 'style'

    def handle_endtag(self, tag):
        if self.skip:
            if tag == self.skip:
                self.skip = None
            return
        self.parts.append(f'</{tag}>')
        if tag == 'style':
            self.in_style = False

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(self.resources.styles(data, SOURCE_URL) if self.in_style else data)

    def handle_entityref(self, name):
        if not self.skip:
            self.parts.append('&' + name + ';')

    def handle_charref(self, name):
        if not self.skip:
            self.parts.append('&#' + name + ';')

    def handle_decl(self, decl):
        self.parts.append('<!' + decl + '>')


def atomic_write(path, data):
    with tempfile.NamedTemporaryFile(delete=False) as temporary:
        temporary.write(data)
        name = temporary.name
    try:
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def build_all(root=ROOT):
    directory = root / 'data/deepseek/offline'
    directory.mkdir(parents=True, exist_ok=True)
    resources = Resources()
    failures = []
    for source in sorted((root / 'data/deepseek/sources').glob('*.html.txt')):
        name = source.name.removesuffix('.html.txt')
        manifest_path = directory / (name + '.json')
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        if manifest_path.exists():
            manifest = json.loads(manifest_path.read_text())
            if manifest.get('source_sha256') == digest and manifest.get('version') == VERSION and all(
                (directory / (name + ext)).exists() for ext in ['.html', '.zip']
            ):
                continue
        try:
            parser = ReadingPage(resources)
            parser.feed(source.read_text())
            parser.close()
            page = ''.join(parser.parts).encode('utf-8')
            manifest = {'version': VERSION, 'source_snapshot': source.relative_to(root).as_posix(),
                        'source_sha256': digest, 'resources_saved_at_utc': datetime.now(timezone.utc).isoformat(),
                        'resources': resources.records, 'mode': 'offline-reading'}
            manifest_bytes = json.dumps(manifest, ensure_ascii=False, indent=2).encode('utf-8')
            with tempfile.TemporaryFile() as buffer:
                with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as bundle:
                    bundle.writestr('index.html', page)
                    bundle.writestr('manifest.json', manifest_bytes)
                    bundle.writestr('README.txt', 'Open index.html directly in a browser. All display resources are embedded. Scripts and online interactions are disabled. Resource backup time is in manifest.json; historical resources may be captured later than the HTML.')
                buffer.seek(0)
                atomic_write(directory / (name + '.zip'), buffer.read())
            atomic_write(directory / (name + '.html'), page)
            atomic_write(manifest_path, manifest_bytes)
            print(f'DeepSeek offline archive saved: {name}')
        except Exception as error:
            resources.active.clear()
            failures.append(f'{name}: {error}')
            print(f'DeepSeek offline archive failed: {name}: {error}')
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as report:
            report.write('\n## DeepSeek offline reading backups\n\n')
            report.write('All available snapshots have complete offline HTML and ZIP copies.\n' if not failures
                         else '\n'.join('- ' + item.replace('\n', ' ') for item in failures) + '\n')
    if failures:
        raise RuntimeError('; '.join(failures))


if __name__ == '__main__':
    build_all()
