using System;
using System.Drawing;
using System.IO;
using System.Text;
using System.Windows.Forms;

internal static class SftpAskpass {
    [STAThread]
    private static int Main(string[] args) {
        if (args.Length != 1) return 1;
        Application.EnableVisualStyles();
        string prompt = args[0];
        string title = "Brclio SFTP · " + Environment.GetEnvironmentVariable("BRCLIO_SFTP_TARGET");
        string answer;
        if (Environment.GetEnvironmentVariable("SSH_ASKPASS_PROMPT") == "confirm" || prompt.Contains("yes/no")) {
            if (MessageBox.Show(prompt, title, MessageBoxButtons.OKCancel,
                MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) != DialogResult.OK) return 1;
            answer = "yes";
        } else {
            using (var form = new Form()) {
                form.Text = title;
                form.ClientSize = new Size(450, 185);
                form.StartPosition = FormStartPosition.CenterScreen;
                form.FormBorderStyle = FormBorderStyle.FixedDialog;
                form.MinimizeBox = false;
                form.MaximizeBox = false;
                var label = new TextBox { Text = prompt, Left = 12, Top = 12, Width = 426, Height = 64,
                    ReadOnly = true, Multiline = true, BorderStyle = BorderStyle.None, ScrollBars = ScrollBars.Vertical };
                var input = new TextBox { Left = 12, Top = 83, Width = 426, UseSystemPasswordChar = true, TabIndex = 0 };
                var ok = new Button { Text = "确定", DialogResult = DialogResult.OK, Left = 265, Top = 133 };
                var cancel = new Button { Text = "取消", DialogResult = DialogResult.Cancel, Left = 356, Top = 133 };
                form.Controls.AddRange(new Control[] { label, input, ok, cancel });
                form.AcceptButton = ok;
                form.CancelButton = cancel;
                form.ActiveControl = input;
                using (var timeout = new Timer { Interval = 120000 }) {
                    timeout.Tick += (s, e) => form.Close();
                    timeout.Start();
                    if (form.ShowDialog() != DialogResult.OK) return 1;
                }
                answer = input.Text;
            }
        }
        byte[] bytes = new UTF8Encoding(false).GetBytes(answer + "\n");
        using (var output = Console.OpenStandardOutput()) output.Write(bytes, 0, bytes.Length);
        return 0;
    }
}
