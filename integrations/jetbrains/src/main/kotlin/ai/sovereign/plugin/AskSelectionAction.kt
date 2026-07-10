package ai.sovereign.plugin

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.wm.ToolWindowManager

class AskSelectionAction : AnAction() {

    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val editor = e.getData(CommonDataKeys.EDITOR)
        e.presentation.isEnabled = editor?.selectionModel?.hasSelection() == true
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        val selection = editor.selectionModel.selectedText ?: return
        val language = e.getData(CommonDataKeys.PSI_FILE)?.language?.id?.lowercase() ?: ""

        val question = Messages.showInputDialog(
            project,
            "Ask your sovereign AI about the selection:",
            "SovereignAI",
            null,
            "Explain this.",
            null,
        ) ?: return

        val toolWindow = ToolWindowManager.getInstance(project).getToolWindow("SovereignAI") ?: return
        toolWindow.activate {
            ChatPanel.instance.sendMessage("$question\n\n```$language\n$selection\n```")
        }
    }
}
