package com.brclio.toolbox;

import org.json.JSONException;
import org.json.JSONObject;

/** The source client's anonymous Python endpoint; no account credential is used. */
final class XhsParsePolicy {
    static final String PYTHON_ENDPOINT = "https://xhs.download.brclio.com/api/python_parse";
    static final int MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

    static JSONObject pythonResponse(int status, String body) {
        if (status >= 300 && status < 400) throw new IllegalArgumentException("解析服务地址发生变化，请更新客户端。");
        final JSONObject result;
        try { result = new JSONObject(body); }
        catch (JSONException error) { throw new IllegalArgumentException("Python 解析服务返回了无效内容，请稍后重试。"); }
        if (status < 200 || status >= 300 || !result.optBoolean("success", false)) {
            String message = result.optString("message", "Python 解析失败，请检查链接后重试。");
            throw new IllegalArgumentException(message.length() <= 500 ? message : "Python 解析失败，请检查链接后重试。");
        }
        return result;
    }
}
