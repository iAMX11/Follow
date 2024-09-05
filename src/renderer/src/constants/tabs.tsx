import { FeedViewType } from "@renderer/lib/enum"

export const views = [
  {
    name: "Articles",
    icon: <i className="i-mgc-paper-cute-fi" />,
    className: "text-accent",
    peerClassName: "peer-checked:text-accent",
    translation: "title,description",
    view: FeedViewType.Articles,
  },
  {
    name: "Social Media",
    icon: <i className="i-mgc-twitter-cute-fi" />,
    className: "text-sky-600 dark:text-sky-500",
    peerClassName: "peer-checked:text-sky-600 peer-checked:dark:text-sky-500",
    wideMode: true,
    translation: "content",
    view: FeedViewType.SocialMedia,
  },
  {
    name: "Pictures",
    icon: <i className="i-mgc-pic-cute-fi" />,
    className: "text-green-600 dark:text-green-500",
    peerClassName: "peer-checked:text-green-600 peer-checked:dark:text-green-500",
    gridMode: true,
    wideMode: true,
    translation: "title",
    view: FeedViewType.Pictures,
  },
  {
    name: "Videos",
    icon: <i className="i-mgc-video-cute-fi" />,
    className: "text-red-600 dark:text-red-500",
    peerClassName: "peer-checked:text-red-600 peer-checked:dark:text-red-500",
    gridMode: true,
    wideMode: true,
    translation: "title",
    view: FeedViewType.Videos,
  },
  {
    name: "Audios",
    icon: <i className="i-mgc-mic-cute-fi" />,
    className: "text-purple-600 dark:text-purple-500",
    peerClassName: "peer-checked:text-purple-600 peer-checked:dark:text-purple-500",
    translation: "title",
    view: FeedViewType.Audios,
  },
  {
    name: "Notifications",
    icon: <i className="i-mgc-announcement-cute-fi" />,
    className: "text-yellow-600 dark:text-yellow-500",
    peerClassName: "peer-checked:text-yellow-600 peer-checked:dark:text-yellow-500",
    translation: "title",
    view: FeedViewType.Notifications,
  },

]
