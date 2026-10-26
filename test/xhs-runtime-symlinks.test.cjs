'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process'),path=require('node:path');

test('native Python runtime copying preserves framework links and rejects unsafe imports in both entry paths',()=>{
 const result=spawnSync(process.platform==='win32'?'python':'python3',['-c',String.raw`
import contextlib, importlib.util, io, json, os, pathlib, shutil, sys, tempfile, unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location("prepare_runtime",sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class RuntimeLinks(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root=pathlib.Path(self.temporary.name)
        try:
            os.symlink("target",self.root/"privilege-probe")
        except OSError as error:
            if os.name=="nt" and getattr(error,"winerror",None)==1314:
                self.skipTest("Windows runner does not grant symlink creation")
            raise
        (self.root/"privilege-probe").unlink()

    def framework(self,source):
        real=source/"_internal/Python.framework/Versions/3.12"
        (real/"Resources").mkdir(parents=True)
        (real/"Python").write_bytes(b"native fixture bytes")
        (real/"Resources/Info.plist").write_text("framework metadata")
        (real.parent/"Current").symlink_to("3.12",target_is_directory=True)
        framework=real.parent.parent
        (framework/"Python").symlink_to(pathlib.Path("Versions")/"Current"/"Python")
        (framework/"Resources").symlink_to(pathlib.Path("Versions")/"Current"/"Resources",target_is_directory=True)
        return framework

    def assertFramework(self,target):
        framework=target/"_internal/Python.framework"
        self.assertEqual((framework/"Python").readlink(),pathlib.Path("Versions")/"Current"/"Python")
        self.assertEqual((framework/"Resources").readlink(),pathlib.Path("Versions")/"Current"/"Resources")
        self.assertEqual((framework/"Versions/Current").readlink(),pathlib.Path("3.12"))
        self.assertEqual((framework/"Python").read_bytes(),b"native fixture bytes")

    def test_both_main_paths_preserve_relative_framework_layout(self):
        for imported in [False,True]:
            with self.subTest(imported=imported):
                root=self.root/str(imported)
                runtime=root/"runtime"/module.native_target()
                source=self.root/"imported/python" if imported else runtime/"build/xhs-python"
                self.framework(source)
                environment=runtime/"build-venv"/("Scripts/python.exe" if sys.platform=="win32" else "bin/python")
                environment.parent.mkdir(parents=True)
                environment.write_bytes(b"build interpreter fixture")
                info={"sourceSha256":module.source_fingerprint(),"target":module.native_target()}
                (source.parent/"build-info.json").write_text(json.dumps(info))
                arguments=["prepare-runtime", "--copy-from", str(source)] if imported else ["prepare-runtime"]
                def health(target):
                    self.assertFramework(target)
                    return {"ok":True,"engine":"python","version":"3.12"}
                with patch.object(module,"ROOT",root),patch.object(module,"health",side_effect=health),patch.object(module.subprocess,"run") as commands,patch.object(sys,"argv",arguments),contextlib.redirect_stdout(io.StringIO()):
                    module.main()
                self.assertEqual(commands.call_count,0 if imported else 2)
                self.assertFramework(runtime/"python")
                module.validate_runtime_links(runtime/"python")

    def test_flattened_versioned_framework_requires_rebuild_before_import_or_check_health(self):
        original=self.root/"original"
        self.framework(original)
        flattened=self.root/"flattened/python"
        shutil.copytree(original,flattened,symlinks=False)
        info={"sourceSha256":module.source_fingerprint(),"target":module.native_target()}
        (flattened.parent/"build-info.json").write_text(json.dumps(info))
        for check in [False,True]:
            with self.subTest(check=check):
                root=self.root/str(check)
                runtime=root/"runtime"/module.native_target()
                target=runtime/"python"
                if check: shutil.copytree(flattened,target)
                else: target.mkdir(parents=True)
                marker=target/"old-runtime-marker"
                marker.write_text("preserve previous runtime")
                (runtime/"build-info.json").write_text(json.dumps(info))
                arguments=["prepare-runtime","--check"] if check else ["prepare-runtime","--copy-from",str(flattened)]
                with patch.object(module,"ROOT",root),patch.object(module,"health") as health,patch.object(sys,"argv",arguments),contextlib.redirect_stdout(io.StringIO()):
                    with self.assertRaisesRegex(RuntimeError,"rebuild the XHS Python runtime"):
                        module.main()
                health.assert_not_called()
                self.assertEqual(marker.read_text(),"preserve previous runtime")

    def test_each_versioned_alias_is_required_but_unversioned_flat_frameworks_are_valid(self):
        for index,name in enumerate(["Versions/Current","Python","Resources"]):
            source=self.root/str(index)
            framework=self.framework(source)
            alias=framework/name
            resolved=alias.resolve()
            alias.unlink()
            if resolved.is_dir(): shutil.copytree(resolved,alias,symlinks=True)
            else: shutil.copy2(resolved,alias)
            with self.assertRaisesRegex(RuntimeError,"rebuild the XHS Python runtime"):
                module.validate_runtime_links(source)
        flat=self.root/"flat"
        framework=flat/"_internal/Python.framework"
        (framework/"Resources").mkdir(parents=True)
        (framework/"Python").write_bytes(b"flat framework")
        module.copy_runtime(flat,self.root/"flat-copy")
        self.assertEqual((self.root/"flat-copy/_internal/Python.framework/Python").read_bytes(),b"flat framework")

    def test_external_absolute_broken_and_cyclic_links_are_rejected_before_copy(self):
        for kind in ["external","absolute","broken","cycle"]:
            with self.subTest(kind=kind):
                source=self.root/kind
                source.mkdir()
                (source/"payload").write_text("inside")
                (self.root/"outside").write_text("outside")
                target={"external":pathlib.Path("..")/"outside","absolute":source/"payload","broken":pathlib.Path("missing"),"cycle":pathlib.Path("loop")}[kind]
                (source/"link").symlink_to(target)
                if kind=="cycle": (source/"loop").symlink_to("link")
                destination=self.root/(kind+"-copy")
                failure={"external":"escapes its root","absolute":"must be relative","broken":"broken or cyclic","cycle":"broken or cyclic"}[kind]
                with self.assertRaisesRegex(RuntimeError,failure): module.copy_runtime(source,destination)
                self.assertFalse(destination.exists())

    def test_destination_is_checked_before_health_or_publication(self):
        source=self.root/"source"
        self.framework(source)
        destination=self.root/"copy"
        real_copytree=shutil.copytree
        def copied(*args,**kwargs):
            result=real_copytree(*args,**kwargs)
            if pathlib.Path(args[1])==destination:
                (destination/"injected-link").symlink_to(pathlib.Path("..")/"outside")
            return result
        (self.root/"outside").write_text("outside")
        with patch.object(module.shutil,"copytree",side_effect=copied),self.assertRaisesRegex(RuntimeError,"escapes its root"):
            module.copy_runtime(source,destination)

unittest.main(argv=["runtime-links"],verbosity=2)
`,path.resolve(__dirname,'../scripts/prepare-xhs-runtime.py')],{encoding:'utf8',timeout:30000});
 assert.equal(result.status,0,result.stderr||result.stdout||result.error?.message);
});
