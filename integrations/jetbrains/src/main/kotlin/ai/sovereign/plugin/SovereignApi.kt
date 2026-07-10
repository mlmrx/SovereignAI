package ai.sovereign.plugin

import com.intellij.ide.util.PropertiesComponent
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.concurrent.CompletableFuture

/** Thin client for the local SovereignAI server. */
object SovereignApi {
    private val http: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(5))
        .build()

    var conversationId: String? = null

    fun serverUrl(): String =
        PropertiesComponent.getInstance().getValue("sovereignai.serverUrl", "http://127.0.0.1:4321").trimEnd('/')

    fun setServerUrl(url: String) =
        PropertiesComponent.getInstance().setValue("sovereignai.serverUrl", url.trimEnd('/'))

    private fun request(path: String, body: String? = null): HttpRequest {
        val builder = HttpRequest.newBuilder(URI.create(serverUrl() + path))
            .header("content-type", "application/json")
            .timeout(Duration.ofMinutes(5))
        return (if (body != null) builder.POST(HttpRequest.BodyPublishers.ofString(body)) else builder.GET()).build()
    }

    /**
     * Stream a chat turn over SSE. Callbacks arrive on a background thread —
     * marshal to the EDT in the UI layer.
     */
    fun chatStream(
        message: String,
        onDelta: (String) -> Unit,
        onDone: () -> Unit,
        onError: (String) -> Unit,
    ): CompletableFuture<Void> {
        val payload = json(
            "message" to message,
            "conversationId" to conversationId,
        )
        return http.sendAsync(request("/api/chat", payload), HttpResponse.BodyHandlers.ofLines())
            .thenAccept { response ->
                if (response.statusCode() !in 200..299) {
                    onError("Server error HTTP ${response.statusCode()} — is `sovereign start` running?")
                    return@thenAccept
                }
                var event = "message"
                response.body().forEach { line ->
                    when {
                        line.startsWith("event:") -> event = line.removePrefix("event:").trim()
                        line.startsWith("data:") -> {
                            val data = line.removePrefix("data:").trim()
                            when (event) {
                                "meta" -> extractString(data, "conversationId")?.let { conversationId = it }
                                "delta" -> extractString(data, "text")?.let(onDelta)
                                "error" -> onError(extractString(data, "message") ?: "unknown error")
                            }
                        }
                    }
                }
                onDone()
            }
            .exceptionally { err ->
                onError("${err.cause?.message ?: err.message} — is the SovereignAI server running?")
                null
            }
    }

    fun saveDocument(name: String, content: String): String {
        val response = http.send(
            request("/api/documents", json("name" to name, "content" to content)),
            HttpResponse.BodyHandlers.ofString(),
        )
        if (response.statusCode() !in 200..299) {
            throw RuntimeException(extractString(response.body(), "error") ?: "HTTP ${response.statusCode()}")
        }
        return name
    }

    // -- minimal JSON helpers (payloads are flat; avoids a serialization dependency) --

    private fun json(vararg pairs: Pair<String, String?>): String =
        pairs.filter { it.second != null }
            .joinToString(",", "{", "}") { "\"${it.first}\":${quote(it.second!!)}" }

    private fun quote(value: String): String = buildString {
        append('"')
        for (ch in value) when (ch) {
            '"' -> append("\\\"")
            '\\' -> append("\\\\")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            '\t' -> append("\\t")
            else -> if (ch < ' ') append("\\u%04x".format(ch.code)) else append(ch)
        }
        append('"')
    }

    /** Extract a top-level string field from a small JSON object. */
    internal fun extractString(jsonText: String, field: String): String? {
        val match = Regex("\"${Regex.escape(field)}\"\\s*:\\s*\"((?:\\\\.|[^\"\\\\])*)\"").find(jsonText) ?: return null
        return match.groupValues[1]
            .replace("\\n", "\n").replace("\\r", "\r").replace("\\t", "\t")
            .replace("\\\"", "\"").replace("\\\\", "\\")
            .replace(Regex("\\\\u([0-9a-fA-F]{4})")) { m -> m.groupValues[1].toInt(16).toChar().toString() }
    }
}
