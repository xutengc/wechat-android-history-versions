#!/bin/bash

# 设为 1 时，检测到新版本会额外下载 APK 并创建 GitHub Release。
# 默认关闭：本仓库只收录官方下载地址，不托管安装包。
PUBLISH_APK_RELEASE="${PUBLISH_APK_RELEASE:-0}"

# 任一步骤失败立即以非零码退出，避免带着未生成的页面上游提交。
set -euo pipefail

function setup_git() {
    git config --global user.email "actions@github.com"
    git config --global user.name "GithubActions"
}

function check_update() {
    wechat_info=`node scripts/getVersion.js`
    IFS="|" read -ra parts <<< "$wechat_info"
    version_info="${parts[0]}"
    download_link="${parts[1]}"
    version="${parts[2]}"
    file_name="${parts[3]}"
}

function wechat_download() {
    mkdir -p wechatAndroid
    if ! wget -q "$download_link" -O "wechatAndroid/$file_name"; then
        >&2 echo -e "Download Failed, please check your network!"
        exit 1
    fi
    prepare_commit
}

function prepare_commit() {
    apk_sum256=`shasum -a 256 wechatAndroid/$file_name | awk '{print $1}'`
    apk_version="$version_info "`date -u '+%Y%m%d'`
    echo "发布版本: $version" > ./wechatAndroid/$file_name.sha256
    echo "更新日期: $(date -u '+%Y-%m-%d %H:%M:%S') (UTC)" >> ./wechatAndroid/$file_name.sha256
    echo "下载地址: $download_link" >> ./wechatAndroid/$file_name.sha256
    echo "Sha256: $apk_sum256" >> ./wechatAndroid/$file_name.sha256
    gh release create v"$version"_`date -u '+%Y%m%d'` ./wechatAndroid/$file_name -F ./wechatAndroid/$file_name.sha256 -t "$apk_version"
    rm -rfv wechatAndroid
}

function main() {
    now_sum256=`shasum -a 256 version.json | awk '{print $1}'`
    setup_git
    check_update    
    latest_sum256=`shasum -a 256 version.json | awk '{print $1}'`
    if [ "$now_sum256" != "$latest_sum256" ]; then
        node scripts/genVersionPages.js
        git add README.md README.zh-CN.md version.json versions && git commit -m "$version_info" && git push origin main
        if [ "$PUBLISH_APK_RELEASE" = "1" ]; then
            wechat_download
        fi
    fi        
}

main