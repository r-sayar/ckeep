package app.notekeeper;

import android.net.Uri;

import com.google.androidbrowserhelper.trusted.LauncherActivity;

/** Second launcher icon: opens NoteKeeper straight on the Feed page. */
public class FeedLauncherActivity extends LauncherActivity {
    @Override
    protected Uri getLaunchingUrl() {
        return Uri.parse("https://keep-jet.vercel.app/?view=feed");
    }
}
