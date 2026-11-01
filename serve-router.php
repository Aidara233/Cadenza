<?php
// PHP 内置服务器（php -S）的路由脚本——只在「静态文件存在就直接发给它」之外补两件事：
//   ① 所有响应加 Cache-Control: no-store（与 serve.ps1 同一条判据：页面 + 几十个模块，
//      不 no-store 就会看到旧副本，而且**毫无提示**）；
//   ② `/config.json` 动态给出核心地址（与 serve.ps1 同一条：页面启动时读它）。
// ⚠️ 它**不是**一个完整的静态服务器：真正的文件由 php -S 自己发（`return false`），
//    这里只处理上面两条。别把它扩成一个「顺便做点什么」的框架。
$root = __DIR__;
$port = $_SERVER['SERVER_PORT'] ?? '17990';
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';

header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

if ($path === '/config.json') {
    // ⚠️ 核心地址：显式给了 `LILARA_CORE` 就照抄（核心在别的机器上 / 走了隧道，头不许改写）；
    //    没给时用**这次请求的 Host** 拼同一个地址 + 核心端口——头绑到局域网之后，页面里的
    //    `127.0.0.1` 指的是**打开页面的那台设备自己**，写死它等于「手机永远连不上」，
    //    而那个症状与「核心没起来」一模一样。
    $coreEnv = getenv('LILARA_CORE');
    $corePort = getenv('LILARA_CORE_PORT') ?: '17988';
    if ($coreEnv) {
        $core = rtrim($coreEnv, '/');
    } else {
        $host = $_SERVER['HTTP_HOST'] ?? '';
        // ⚠️ 不用 `str_starts_with`（PHP 8.0+）：serve.sh 挑的是「现成的 php」，
        // 发行版里 7.4 还很常见。
        if ($host !== '' && $host[0] === '[') {              // IPv6 字面量：[::1]:17990
            $end = strpos($host, ']');
            $hostOnly = $end === false ? '' : substr($host, 0, $end + 1);
        } else {
            $hostOnly = explode(':', $host, 2)[0];          // 192.168.1.5:17990 → 192.168.1.5
        }
        $core = 'http://' . ($hostOnly !== '' ? $hostOnly : '127.0.0.1') . ':' . $corePort;
    }
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['core' => $core], JSON_UNESCAPED_SLASHES);
    return true;
}

// 目录 → index.html（与 serve.ps1 一致）。
if ($path === '/' || $path === '') { $path = '/index.html'; }

$full = realpath($root . $path);
$rootReal = realpath($root);
// ⚠️ 越界闸：形状校验（解析出来的绝对路径必须仍在根目录之下），
//    与核心 `SessionToolContext.ResolvePath` 同一条判据，不是「看着像不像」。
if ($full === false || $rootReal === false || strpos($full, $rootReal . DIRECTORY_SEPARATOR) !== 0) {
    http_response_code(404);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'not found: ' . $path;
    return true;
}

// 交给 php -S 自己发：它会给正确的 Content-Type 与 Content-Length。
return false;
