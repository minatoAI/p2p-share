// 只读静态服务。够原型用：GET、Content-Type、Content-Length，一条连接一个请求。
#include "server.h"

// winsock2 必须在 windows.h 之前
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>

#include <atomic>
#include <cctype>
#include <cstdio>
#include <fstream>
#include <string>
#include <thread>

namespace proto {
namespace {

std::atomic<bool> g_running{false};
std::string g_url;
int g_port = 0;

std::string url_decode(const std::string& in) {
    std::string out;
    out.reserve(in.size());
    for (size_t i = 0; i < in.size(); i++) {
        if (in[i] == '%' && i + 2 < in.size()) {
            const auto hex = [](char c) -> int {
                if (c >= '0' && c <= '9') return c - '0';
                if (c >= 'a' && c <= 'f') return c - 'a' + 10;
                if (c >= 'A' && c <= 'F') return c - 'A' + 10;
                return -1;
            };
            const int hi = hex(in[i + 1]);
            const int lo = hex(in[i + 2]);
            if (hi >= 0 && lo >= 0) {
                out.push_back(static_cast<char>(hi * 16 + lo));
                i += 2;
                continue;
            }
        }
        out.push_back(in[i]);
    }
    return out;
}

const char* content_type(const std::string& path) {
    const auto dot = path.find_last_of('.');
    std::string ext = dot == std::string::npos ? "" : path.substr(dot + 1);
    for (auto& c : ext) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    if (ext == "html") return "text/html; charset=utf-8";
    if (ext == "js" || ext == "mjs") return "text/javascript; charset=utf-8";
    if (ext == "css") return "text/css; charset=utf-8";
    if (ext == "json" || ext == "webmanifest") return "application/json; charset=utf-8";
    if (ext == "png") return "image/png";
    if (ext == "jpg" || ext == "jpeg") return "image/jpeg";
    if (ext == "svg") return "image/svg+xml";
    if (ext == "ico") return "image/x-icon";
    if (ext == "woff2") return "font/woff2";
    if (ext == "map") return "application/json";
    if (ext == "txt") return "text/plain; charset=utf-8";
    return "application/octet-stream";
}

void send_all(SOCKET socket, const char* data, size_t size) {
    size_t sent = 0;
    while (sent < size) {
        const int n = ::send(socket, data + sent, static_cast<int>(size - sent), 0);
        if (n <= 0) return;
        sent += static_cast<size_t>(n);
    }
}

void respond(SOCKET socket, const std::string& status, const char* type, const std::string& body) {
    std::string head = "HTTP/1.1 " + status + "\r\n";
    head += std::string("Content-Type: ") + type + "\r\n";
    head += "Content-Length: " + std::to_string(body.size()) + "\r\n";
    head += "Cache-Control: no-store\r\n";
    head += "Connection: close\r\n\r\n";
    send_all(socket, head.data(), head.size());
    send_all(socket, body.data(), body.size());
}

void serve_one(SOCKET socket, const std::filesystem::path& root) {
    DWORD timeout = 3000;
    setsockopt(socket, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&timeout),
               sizeof(timeout));

    std::string request;
    char buffer[4096];
    while (request.size() < 16384) {
        const int n = ::recv(socket, buffer, sizeof(buffer), 0);
        if (n <= 0) break;
        request.append(buffer, static_cast<size_t>(n));
        if (request.find("\r\n\r\n") != std::string::npos) break;
    }

    const auto line_end = request.find("\r\n");
    const std::string line = request.substr(0, line_end);
    std::string method, target;
    {
        const auto first = line.find(' ');
        const auto second = line.find(' ', first + 1);
        if (first != std::string::npos && second != std::string::npos) {
            method = line.substr(0, first);
            target = line.substr(first + 1, second - first - 1);
        }
    }
    if (method != "GET" && method != "HEAD") {
        respond(socket, "405 Method Not Allowed", "text/plain; charset=utf-8", "method not allowed");
        return;
    }
    if (const auto q = target.find('?'); q != std::string::npos) target.resize(q);
    std::string path = url_decode(target);
    if (path.empty() || path == "/") path = "/index.html";
    if (path.find("..") != std::string::npos) {
        respond(socket, "403 Forbidden", "text/plain; charset=utf-8", "forbidden");
        return;
    }
    if (path.front() == '/') path.erase(0, 1);

    std::ifstream file(root / std::filesystem::u8path(path), std::ios::binary);
    if (!file) {
        respond(socket, "404 Not Found", "text/plain; charset=utf-8", "not found: " + path);
        return;
    }
    std::string body((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
    respond(socket, "200 OK", content_type(path), body);
}

}  // namespace

std::string server_url() { return g_url; }

bool start_server(const std::filesystem::path& root, int first_port) {
    if (!std::filesystem::exists(root / "index.html")) {
        std::fprintf(stderr, "[界面] %s 下没有 index.html，本地服务没起\n", root.u8string().c_str());
        return false;
    }

    WSADATA data = {};
    if (WSAStartup(MAKEWORD(2, 2), &data) != 0) return false;

    SOCKET listener = INVALID_SOCKET;
    for (int port = first_port; port < first_port + 12; port++) {
        SOCKET candidate = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
        if (candidate == INVALID_SOCKET) continue;
        BOOL reuse = TRUE;
        setsockopt(candidate, SOL_SOCKET, SO_REUSEADDR, reinterpret_cast<const char*>(&reuse),
                   sizeof(reuse));
        sockaddr_in address = {};
        address.sin_family = AF_INET;
        address.sin_port = htons(static_cast<u_short>(port));
        inet_pton(AF_INET, "127.0.0.1", &address.sin_addr);
        if (::bind(candidate, reinterpret_cast<sockaddr*>(&address), sizeof(address)) == 0 &&
            ::listen(candidate, 16) == 0) {
            listener = candidate;
            g_port = port;
            break;
        }
        closesocket(candidate);
    }
    if (listener == INVALID_SOCKET) {
        WSACleanup();
        return false;
    }

    g_url = "http://127.0.0.1:" + std::to_string(g_port) + "/";
    g_running = true;
    std::printf("[界面] 本地服务在 %s\n", g_url.c_str());
    std::fflush(stdout);

    std::thread([listener, root]() {
        while (g_running.load()) {
            fd_set read_set;
            FD_ZERO(&read_set);
            FD_SET(listener, &read_set);
            timeval wait = {0, 300000};
            if (::select(0, &read_set, nullptr, nullptr, &wait) <= 0) continue;
            SOCKET client = ::accept(listener, nullptr, nullptr);
            if (client == INVALID_SOCKET) continue;
            std::thread([client, root]() {
                serve_one(client, root);
                closesocket(client);
            }).detach();
        }
        closesocket(listener);
    }).detach();

    return true;
}

}  // namespace proto
