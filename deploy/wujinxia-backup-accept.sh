#!/usr/bin/env bash
# 备份接收端唯一允许的入口：这把密钥只能把文件推进 /var/backups/wujinxia-app-cloud，
# 或对目录内的本项目备份文件算校验和、按清单清理。不开 shell、不开 sftp 子系统。
# 路径校验一律按规范化后的真实路径判定：前缀字符串相等挡不住 ../、符号链接和子目录跳转。
set -euo pipefail

DIR="${WUJINXIA_BACKUP_ACCEPT_DIR:-/var/backups/wujinxia-app-cloud}"
raw="${SSH_ORIGINAL_COMMAND:-}"

deny() {
  echo "wujinxia-backup-accept: 该命令不在允许范围内" >&2
  exit 1
}
unquote() {
  local value="$1"
  value="${value%\"}"; value="${value#\"}"
  value="${value%\'}"; value="${value#\'}"
  printf '%s' "$value"
}
# 收件目录自身先规范化：比较时只用规范化后的前缀，避免 /a/../b 这类拼写绕过。
# 目录还不存在时（首次 install -d）退回按字面值判定，由 install 分支自己负责创建。
BASE_DIR="$(/usr/bin/readlink -f -- "$DIR" 2>/dev/null || true)"
[ -n "$BASE_DIR" ] || BASE_DIR="$DIR"
is_package_name() {
  [[ "$1" =~ ^wujinxia-app-cloud-[0-9]{8}-[0-9]{6}\.db\.enc(\.manifest\.json)?$ ]]
}
# 密文包与它的清单之外的一切（含 .ssh、authorized_keys、别人的备份）都不许碰。
# 判定按规范化后的真实路径：先拒掉任何包含 .. 的写法，再要求规范化结果直接落在收件目录下。
acceptable_file() {
  local candidate="$1" real="" parent=""
  [ -n "$candidate" ] || return 1
  case "$candidate" in *..*) return 1 ;; esac
  real="$(/usr/bin/readlink -f -- "$candidate" 2>/dev/null)" || return 1
  parent="$(dirname -- "$real")"
  [ "$parent" = "$BASE_DIR" ] || return 1
  [ "$real" != "$BASE_DIR" ] || return 1
  is_package_name "$(basename -- "$real")" || return 1
  # 自身是符号链接的一律拒绝：链接目标可能已经跳到收件目录之外。
  [ -L "$candidate" ] && return 1
  return 0
}
# 不带分隔符的写法按收件目录里的文件名理解；带分隔符的原样交给上面的规范化判定。
normalize_arg() {
  case "$1" in
    */*) printf '%s' "$1" ;;
    *) printf '%s/%s' "$BASE_DIR" "$1" ;;
  esac
}

package_list() {
  /usr/bin/ls -1 -- "$BASE_DIR" | grep -E '^wujinxia-app-cloud-[0-9]{8}-[0-9]{6}\.db\.enc$' | sort
}

purge_files() {
  local names=() name target removed left newest
  read -r -a names <<<"$(printf '%s' "${raw#purge }" | tr -d '"')"
  [ "${#names[@]}" -gt 0 ] || deny
  for name in "${names[@]}"; do
    is_package_name "$name" || deny
    target="$BASE_DIR/$name"
    acceptable_file "$target" || deny
    # 只删本目录里的普通文件：目录、符号链接、别的文件一律拒绝。
    [ -f "$target" ] && [ ! -L "$target" ] || deny
  done
  newest="$(package_list | tail -1)"
  [ -n "$newest" ] || deny
  for name in "${names[@]}"; do
    # 最新一份密文包不在删除范围内，哪怕清单把它算进来了也拒绝。
    [ "$name" != "$(basename "$newest")" ] || deny
  done
  removed=0
  for name in "${names[@]}"; do
    if /usr/bin/rm -f -- "$BASE_DIR/$name"; then
      removed=$((removed + 1))
      echo "purged $name"
    else
      echo "wujinxia-backup-accept: 删除失败 $name" >&2
      exit 1
    fi
  done
  left="$(package_list | wc -l)"
  [ "$left" -gt 0 ] || { echo "wujinxia-backup-accept: 删除后没有留下任何密文包" >&2; exit 1; }
  echo "remaining_packages $left"
  echo "removed $removed"
}

case "$raw" in
  'install -d -m 0750 '*)
    target="$(unquote "${raw#install -d -m 0750 }")"
    # 只允许创建收件目录本身，路径写法必须与配置的目录一致。
    [ "$target" = "$DIR" ] || [ "$target" = "$BASE_DIR" ] || deny
    exec /usr/bin/install -d -m 0750 "$BASE_DIR"
    ;;
  'sha256sum '*)
    target="$(normalize_arg "$(unquote "${raw#sha256sum }")")"
    acceptable_file "$target" || deny
    [ -f "$target" ] || deny
    exec /usr/bin/sha256sum "$target"
    ;;
  scp\ -[A-Za-z]*\ -t\ *|scp\ -t\ *|scp\ -r\ -t\ *)
    # 客户端发来的形如 `scp -t <目标路径>`；目标必须规范化后直接落在收件目录内且是本项目文件名。
    # shellcheck disable=SC2206
    args=($raw)
    target="$(normalize_arg "${args[-1]}")"
    acceptable_file "$target" || deny
    exec /usr/bin/scp -t "$target"
    ;;
  list)
    exec /usr/bin/ls -1 -- "$BASE_DIR"
    ;;
  purge\ *)
    purge_files
    ;;
  *) deny ;;
esac
