#!/usr/bin/env bash
# Install only this project's static design preview; never restart app services.
set -euo pipefail

release=${1:?release required}
expected_nginx_sha=${2:?current nginx SHA256 required}
[[ "$release" =~ ^20261020-[0-9a-f]{12}$ ]] || exit 2
[[ "$expected_nginx_sha" =~ ^[0-9a-f]{64}$ ]] || exit 2

root=/var/www/wujinxia-app-prototypes
staging=/tmp/wujinxia-app-preview-$release
site=/etc/nginx/conf.d/wujinxia-app-cloud.conf
include=/etc/nginx/wujinxia-app-design-preview.conf
release_dir=$root/releases/$release
backup=/var/lib/wujinxia-app-preview-deploy/$(date -u +%Y%m%dT%H%M%SZ)-$release

[[ $(id -u) == 0 ]] || { echo 'Root deployment required' >&2; exit 2; }
[[ $(sha256sum "$site" | cut -d' ' -f1) == "$expected_nginx_sha" ]] || { echo 'Project nginx config changed; refusing overwrite' >&2; exit 3; }
for file in site.tar.gz files.sha256 nginx-wujinxia-app-cloud.conf nginx-wujinxia-app-design-preview.conf; do
    [[ -f "$staging/$file" && ! -L "$staging/$file" ]] || exit 4
done
nginx -t
getent passwd wujinxia-app-preview >/dev/null || useradd --system --home-dir "$root" --shell /usr/sbin/nologin wujinxia-app-preview
install -d -m 0755 -o wujinxia-app-preview -g wujinxia-app-preview "$root" "$root/releases"
install -d -m 0700 "$backup"
cp -a "$site" "$backup/site.conf"
had_include=0
if [[ -e "$include" ]]; then cp -a "$include" "$backup/preview.conf"; had_include=1; fi
previous=''
if [[ -e "$root/current" || -L "$root/current" ]]; then
    [[ -L "$root/current" ]] || { echo 'Current preview is not a release symlink' >&2; exit 5; }
    previous=$(readlink "$root/current")
    [[ "$previous" =~ ^releases/20261020-[0-9a-f]{12}$ ]] || exit 5
fi
printf '%s\n' "$previous" > "$backup/current.before"
needs_reload=0
if ! cmp -s "$staging/nginx-wujinxia-app-cloud.conf" "$site" || ! cmp -s "$staging/nginx-wujinxia-app-design-preview.conf" "$include"; then needs_reload=1; fi

if [[ ! -e "$release_dir" ]]; then
    install -d -m 0755 "$release_dir"
    tar --no-same-owner --no-same-permissions -xzf "$staging/site.tar.gz" -C "$release_dir"
fi
(cd "$release_dir" && sha256sum --quiet -c "$staging/files.sha256")
chown -R wujinxia-app-preview:wujinxia-app-preview "$release_dir"
find "$release_dir" -type d -exec chmod 0755 {} +
find "$release_dir" -type f -exec chmod 0644 {} +

restore() {
    cp -a "$backup/site.conf" "$site"
    if [[ "$had_include" == 1 ]]; then cp -a "$backup/preview.conf" "$include"; else rm -f -- "$include"; fi
    if [[ -n "$previous" ]]; then
        ln -sfn "$previous" "$root/.current-rollback-$release"
        mv -Tf "$root/.current-rollback-$release" "$root/current"
    elif [[ -L "$root/current" && $(readlink "$root/current") == "releases/$release" ]]; then
        rm -- "$root/current"
    fi
}
trap 'result=$?; if [[ $result != 0 ]]; then restore; if [[ $needs_reload == 1 ]]; then nginx -t && systemctl reload nginx || true; fi; fi; exit $result' EXIT
install -m 0644 "$staging/nginx-wujinxia-app-design-preview.conf" "$include"
install -m 0644 "$staging/nginx-wujinxia-app-cloud.conf" "$site"
ln -sfn "releases/$release" "$root/.current-$release"
mv -Tf "$root/.current-$release" "$root/current"
nginx -t
# User requested public deployment. Graceful config reload; no process restart.
if [[ "$needs_reload" == 1 ]]; then systemctl reload nginx; fi
trap - EXIT
printf 'Published release=%s files=%s reloaded=%s backup=%s\n' "$release" "$(wc -l < "$staging/files.sha256")" "$needs_reload" "$backup"
printf 'URL=https://wujinxia01.ainiannian.online/preview/\n'
