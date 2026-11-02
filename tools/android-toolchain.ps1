param(
  [ValidateSet('All', 'Jdk', 'Gradle', 'Sdk', 'Node', 'Cxx')]
  [string]$Component = 'All'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$toolRoot = Join-Path $repoRoot '.runtime\android-toolchain'
$downloadRoot = Join-Path $repoRoot '.runtime\android-downloads'
New-Item -ItemType Directory -Force -Path $toolRoot, $downloadRoot | Out-Null

function Get-NetworkOptions([string]$Url) {
  $requestedUri = [uri]$Url
  if ($requestedUri.Host -in @('dl.google.com', 'downloads.gradle.org')) { return @() }
  $proxyUri = [System.Net.WebRequest]::DefaultWebProxy.GetProxy($requestedUri)
  if ($proxyUri.Host -ne $requestedUri.Host -and $proxyUri.IsLoopback) {
    return @('--proxy', "$($proxyUri.Scheme)://$($proxyUri.Host):$($proxyUri.Port)")
  }
  return @()
}

function Get-RemoteText([string]$Url) {
  $networkOptions = @(Get-NetworkOptions $Url)
  $result = & curl.exe @networkOptions --tls-max 1.2 --http1.1 --fail --location --retry 3 --retry-all-errors --retry-delay 2 --connect-timeout 20 --max-time 120 --silent --show-error $Url
  if ($LASTEXITCODE -ne 0) { throw "Metadata download failed: $Url" }
  return ($result -join "`n")
}

function Get-VerifiedDownload([string]$Url, [string]$Name, [string]$Hash = '', [string]$Algorithm = 'SHA256') {
  $destination = Join-Path $downloadRoot $Name
  if (-not (Test-Path -LiteralPath $destination)) {
    $partialPath = "$destination.partial"
    $networkOptions = @(Get-NetworkOptions $Url)
    & curl.exe @networkOptions --tls-max 1.2 --http1.1 --fail --location --retry 3 --retry-all-errors --retry-delay 2 --connect-timeout 20 --max-time 1200 --silent --show-error --output $partialPath $Url
    if ($LASTEXITCODE -ne 0) { throw "Download failed: $Name" }
    Move-Item -LiteralPath $partialPath -Destination $destination -Force
  }
  if ($Hash -and (Get-FileHash -LiteralPath $destination -Algorithm $Algorithm).Hash -ne $Hash) {
    throw "Checksum mismatch: $Name"
  }
  Write-Host "Verified download: $Name ($((Get-Item -LiteralPath $destination).Length) bytes)"
  return $destination
}

function Expand-Into([string]$Archive, [string]$Destination) {
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  Expand-Archive -LiteralPath $Archive -DestinationPath $Destination -Force
}

if ($Component -in @('All', 'Jdk')) {
  $releases = (Get-RemoteText 'https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=x64&heap_size=normal&image_type=jdk&jvm_impl=hotspot&os=windows&vendor=eclipse') | ConvertFrom-Json
  $asset = $releases[0].binary.package
  $asset | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $downloadRoot 'jdk-asset.json') -Encoding UTF8
  $archive = Get-VerifiedDownload $asset.link $asset.name $asset.checksum
  $jdkParent = Join-Path $toolRoot 'jdk'
  Expand-Into $archive $jdkParent
  $jdkFolder = Get-ChildItem -LiteralPath $jdkParent -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'bin\java.exe') } | Select-Object -First 1
  if (-not $jdkFolder) { throw 'Extracted JDK was not found' }
  $jdkFolder.FullName | Set-Content -LiteralPath (Join-Path $toolRoot 'java-home.txt') -Encoding UTF8
  & (Join-Path $jdkFolder.FullName 'bin\java.exe') -version
}

if ($Component -in @('All', 'Gradle')) {
  $gradleName = 'gradle-8.9-bin.zip'
  $gradleUrl = "https://downloads.gradle.org/distributions/$gradleName"
  $gradleHash = (Get-RemoteText "$gradleUrl.sha256").Trim()
  $archive = Get-VerifiedDownload $gradleUrl $gradleName $gradleHash
  Expand-Into $archive $toolRoot
  Write-Host "Gradle ready: $(Join-Path $toolRoot 'gradle-8.9\bin\gradle.bat')"
}

if ($Component -in @('All', 'Sdk')) {
  $repositoryUrl = 'https://dl.google.com/android/repository/repository2-1.xml'
  [xml]$repository = Get-RemoteText $repositoryUrl
  $repository.Save((Join-Path $downloadRoot 'repository2-1.xml'))
  $sdkRoot = Join-Path $toolRoot 'sdk'
  $packages = @(
    @{ Path = 'cmdline-tools;latest'; Destination = 'cmdline-tools\latest'; ArchiveName = '' },
    @{ Path = 'platforms;android-35'; Destination = 'platforms\android-35'; ArchiveName = 'platform-35_r02.zip' },
    @{ Path = 'build-tools;35.0.0'; Destination = 'build-tools\35.0.0'; ArchiveName = '' }
  )
  foreach ($selection in $packages) {
    $targetRoot = Join-Path $sdkRoot $selection.Destination
    if (Test-Path -LiteralPath (Join-Path $targetRoot 'source.properties')) {
      Write-Host "SDK package already ready: $($selection.Path)"
      continue
    }
    $archiveInfo = $null
    foreach ($package in $repository.SelectNodes('//*[local-name()="remotePackage"]')) {
      if ($package.path -ne $selection.Path) { continue }
      foreach ($candidate in $package.archives.archive) {
        if ($candidate.'host-os' -and $candidate.'host-os' -ne 'windows') { continue }
        if ($selection.ArchiveName -and $candidate.complete.url -ne $selection.ArchiveName) { continue }
        $archiveInfo = $candidate.complete
        break
      }
      if ($archiveInfo) { break }
    }
    if (-not $archiveInfo) { throw "Official SDK package not found: $($selection.Path)" }
    $archiveName = [string]$archiveInfo.url
    $archive = Get-VerifiedDownload "https://dl.google.com/android/repository/$archiveName" $archiveName ([string]$archiveInfo.checksum) 'SHA1'
    $extractRoot = Join-Path $toolRoot ('.extract-' + $archiveName.Replace('.zip', ''))
    Expand-Into $archive $extractRoot
    $extractedFolder = Get-ChildItem -LiteralPath $extractRoot -Directory | Select-Object -First 1
    if (-not $extractedFolder) { throw "No directory in SDK archive: $archiveName" }
    New-Item -ItemType Directory -Force -Path $targetRoot | Out-Null
    Copy-Item -Path (Join-Path $extractedFolder.FullName '*') -Destination $targetRoot -Recurse -Force
    Write-Host "SDK package ready: $($selection.Path)"
  }
  $sdkRoot | Set-Content -LiteralPath (Join-Path $toolRoot 'sdk-home.txt') -Encoding UTF8
}

if ($Component -in @('All', 'Node')) {
  $release = (Get-RemoteText 'https://api.github.com/repos/nodejs-mobile/nodejs-mobile/releases/tags/v18.20.4') | ConvertFrom-Json
  $asset = $release.assets | Where-Object name -eq 'nodejs-mobile-v18.20.4-android.zip' | Select-Object -First 1
  if (-not $asset) { throw 'Official nodejs-mobile Android asset was not found' }
  $asset | Select-Object name, size, browser_download_url, digest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $downloadRoot 'nodejs-mobile-asset.json') -Encoding UTF8
  $assetHash = ''
  if ($asset.digest -like 'sha256:*') { $assetHash = $asset.digest.Substring(7) }
  $archive = Get-VerifiedDownload $asset.browser_download_url $asset.name $assetHash
  $nodeRoot = Join-Path $toolRoot 'nodejs-mobile-v18.20.4'
  Expand-Into $archive $nodeRoot
  Get-ChildItem -LiteralPath $nodeRoot -Recurse -File -Filter '*.so' | ForEach-Object FullName
}

if ($Component -in @('All', 'Cxx')) {
  # nodejs-mobile v18.20.4 uses NDK r24 in its official build-mobile workflow.
  # Download only ZIP directory records and the two C++ runtime entries.
  $cxxRoot = Join-Path $toolRoot 'ndk-r24-cxx'
  @'
import io, json, pathlib, struct, sys, urllib.request, zlib, hashlib
base = pathlib.Path(sys.argv[1])
base.mkdir(parents=True, exist_ok=True)
url = 'https://dl.google.com/android/repository/android-ndk-r24-windows.zip'
size = 663076813
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
def read_range(start, end):
    req = urllib.request.Request(url, headers={'Range': f'bytes={start}-{end}', 'Accept-Encoding': 'identity'})
    with opener.open(req, timeout=60) as response:
        if response.status != 206:
            raise RuntimeError(f'Range request returned {response.status}; refusing full NDK download')
        result = response.read(end - start + 2)
        if len(result) != end - start + 1:
            raise RuntimeError('Unexpected range response length')
        return result
tail_start = size - 131072
tail = read_range(tail_start, size - 1)
eocd = tail.rfind(b'PK\x05\x06')
if eocd < 0:
    raise RuntimeError('ZIP end record was not found')
_, disk, cd_disk, entries_disk, entries, cd_size, cd_offset, comment = struct.unpack_from('<4s4H2LH', tail, eocd)
directory = read_range(cd_offset, cd_offset + cd_size - 1)
offset = 0
selected = []
while offset < len(directory):
    fields = struct.unpack_from('<4s6H3L5H2L', directory, offset)
    if fields[0] != b'PK\x01\x02':
        raise RuntimeError('Invalid central-directory record')
    name_len, extra_len, comment_len = fields[10:13]
    name = directory[offset + 46:offset + 46 + name_len].decode('utf-8')
    for triple, abi in [('aarch64-linux-android', 'arm64-v8a'), ('x86_64-linux-android', 'x86_64')]:
        if name.endswith('/' + triple + '/libc++_shared.so'):
            selected.append((name, abi, fields))
    offset += 46 + name_len + extra_len + comment_len
if len(selected) != 2:
    raise RuntimeError(f'Expected two C++ runtime entries, got {len(selected)}')
manifest = []
for name, abi, fields in selected:
    method, crc, compressed, uncompressed, local_offset = fields[4], fields[7], fields[8], fields[9], fields[16]
    header = read_range(local_offset, local_offset + 29)
    local = struct.unpack('<4s5H3L2H', header)
    payload_offset = local_offset + 30 + local[9] + local[10]
    payload = read_range(payload_offset, payload_offset + compressed - 1)
    content = zlib.decompress(payload, -15) if method == 8 else payload
    if len(content) != uncompressed or zlib.crc32(content) & 0xffffffff != crc:
        raise RuntimeError(f'ZIP CRC or size mismatch for {abi}')
    destination = base / abi / 'libc++_shared.so'
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(content)
    row = {'abi': abi, 'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest(), 'source': url, 'entry': name, 'zip_crc32': f'{crc:08x}'}
    manifest.append(row)
    print(json.dumps(row))
(base / 'source-manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
'@ | python - $cxxRoot
  if ($LASTEXITCODE -ne 0) { throw 'Official NDK C++ runtime extraction failed' }
}

Write-Host 'Portable Android toolchain complete. No global environment variables were changed.'
