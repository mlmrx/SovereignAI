package ai.sovereign.plugin

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.application.ApplicationManager

class SaveSelectionAction : AnAction() {

    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val editor = e.getData(CommonDataKeys.EDITOR)
        e.presentation.isEnabled = editor?.selectionModel?.hasSelection() == true
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        val selection = editor.selectionModel.selectedText ?: return
        val file = e.getData(CommonDataKeys.VIRTUAL_FILE)
        val startLine = editor.document.getLineNumber(editor.selectionModel.selectionStart) + 1
        val endLine = editor.document.getLineNumber(editor.selectionModel.selectionEnd) + 1
        val name = "${file?.name ?: "selection"} (lines $startLine–$endLine)"

        ApplicationManager.getApplication().executeOnPooledThread {
            val (message, type) = try {
                SovereignApi.saveDocument(name, selection)
                "⬡ Saved to your AI's knowledge: $name" to NotificationType.INFORMATION
            } catch (err: Exception) {
                "SovereignAI: ${err.message}" to NotificationType.ERROR
            }

            NotificationGroupManager.getInstance()
                .getNotificationGroup("SovereignAI")
                .createNotification(message, type)
                .notify(project)
        }
    }
}
