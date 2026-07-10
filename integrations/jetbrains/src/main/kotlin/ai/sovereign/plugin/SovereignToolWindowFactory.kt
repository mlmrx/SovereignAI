package ai.sovereign.plugin

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.event.KeyAdapter
import java.awt.event.KeyEvent
import javax.swing.JButton
import javax.swing.JPanel
import javax.swing.JTextArea
import javax.swing.SwingUtilities

class SovereignToolWindowFactory : ToolWindowFactory {

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val panel = ChatPanel.instance
        val content = toolWindow.contentManager.factory.createContent(panel, "", false)
        toolWindow.contentManager.addContent(content)
    }
}

/** Singleton chat panel so editor actions can push messages into it. */
class ChatPanel private constructor() : JPanel(BorderLayout()) {

    private val log = JBTextArea().apply {
        isEditable = false
        lineWrap = true
        wrapStyleWord = true
        margin = JBUI.insets(8)
        text = "⬡ Your sovereign AI. Private. Local. Yours.\n\n"
    }
    private val input = JBTextArea(3, 0).apply {
        lineWrap = true
        wrapStyleWord = true
        margin = JBUI.insets(6)
    }
    @Volatile private var busy = false

    init {
        add(JBScrollPane(log), BorderLayout.CENTER)

        val send = JButton("Send").apply { addActionListener { submit() } }
        val bottom = JPanel(BorderLayout(JBUI.scale(6), 0)).apply {
            border = JBUI.Borders.empty(6)
            add(JBScrollPane(input), BorderLayout.CENTER)
            add(send, BorderLayout.EAST)
        }
        add(bottom, BorderLayout.SOUTH)

        input.addKeyListener(object : KeyAdapter() {
            override fun keyPressed(e: KeyEvent) {
                if (e.keyCode == KeyEvent.VK_ENTER && !e.isShiftDown) {
                    e.consume()
                    submit()
                }
            }
        })
    }

    private fun submit() {
        val text = input.text.trim()
        if (text.isEmpty() || busy) return
        input.text = ""
        sendMessage(text)
    }

    fun sendMessage(text: String) {
        if (busy) return
        busy = true
        appendLine("you  $text\n")
        append("⬡  ")
        SovereignApi.chatStream(
            text,
            onDelta = { delta -> onEdt { append(delta) } },
            onDone = { onEdt { appendLine("\n"); busy = false } },
            onError = { message -> onEdt { appendLine("\n⚠️ $message\n"); busy = false } },
        )
    }

    private fun append(s: String) {
        log.append(s)
        log.caretPosition = log.document.length
    }

    private fun appendLine(s: String) = append(s + "\n")

    private fun onEdt(block: () -> Unit) = SwingUtilities.invokeLater(block)

    companion object {
        val instance: ChatPanel by lazy { ChatPanel() }
    }
}
