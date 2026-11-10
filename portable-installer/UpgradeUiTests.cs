using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Drawing;
using System.Windows.Forms;

internal static class UpgradeUiTests
{
    [STAThread]
    private static int Main(string[] args) {
        try {
            Application.EnableVisualStyles();
            var assembly = Assembly.LoadFrom(Path.GetFullPath(args[0]));
            var core = assembly.GetType("UpgradeCore");
            var bundle = core.GetMethod("LoadBundle",BindingFlags.Static|BindingFlags.NonPublic).Invoke(null,null);
            var guid = (string)bundle.GetType().GetField("guid").GetValue(bundle);
            if (guid != "47e76a39-27f8-5672-b9b0-dc99c558e785") throw new Exception("invalid embedded identity");
            using (var form = (Form)Activator.CreateInstance(assembly.GetType("UpgradeWindow"), BindingFlags.Instance|BindingFlags.NonPublic,null,new object[]{new string[0]},null)) {
                form.ShowInTaskbar=false;form.Opacity=0;form.Show();Application.DoEvents();
                var selector=form.Controls.OfType<ComboBox>().Single();
                var type=assembly.GetType("Installation");
                var item=Activator.CreateInstance(type,true);
                type.GetField("Path").SetValue(item,"C:\\测试旧版白球");
                type.GetField("Version").SetValue(item,"3.0.20");
                selector.Items.Add(item);selector.SelectedItem=item;Application.DoEvents();
                if (selector.Text!="C:\\测试旧版白球") throw new Exception("selected target is not raw path: "+selector.Text);
                var buttons=form.Controls.OfType<Button>().ToArray();
                if (!buttons.Any(button=>button.Text=="恢复上次升级") || !buttons.Any(button=>button.Text=="复制诊断")) throw new Exception("missing recovery controls");
                if (buttons.Single(button=>button.Text=="启动白球").Enabled) throw new Exception("launch allowed before install");
                using(var image=new Bitmap(form.Width,form.Height)) {form.DrawToBitmap(image,new Rectangle(Point.Empty,image.Size));image.Save(args[1]);}
                form.Close();
            }
            Console.WriteLine("PASS UI checks=5; embedded bundle, selected target, recovery, diagnosis, launch gating; no installation");return 0;
        } catch(Exception error) { Console.WriteLine(error.ToString());return 1; }
    }
}
