'use strict';

require('dotenv').config(); // Load environment variables from .env file
const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs'); // Import File System module
const path = require('path'); // Import Path module

// Basic configuration validation
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

if (!lineConfig.channelAccessToken || !lineConfig.channelSecret) {
  console.error('Error: LINE_CHANNEL_ACCESS_TOKEN and LINE_CHANNEL_SECRET must be set in .env file.');
  process.exit(1);
}

const photoApiUrl = process.env.PHOTO_API_URL;
const photoBaseUrl = process.env.PHOTO_BASE_URL;
const geminiApiKey = process.env.GEMINI_API_KEY;

if (!photoApiUrl || !photoBaseUrl) {
    console.error('Error: PHOTO_API_URL and PHOTO_BASE_URL must be set in .env file.');
    process.exit(1);
}
if (!geminiApiKey) {
    console.error('Error: GEMINI_API_KEY must be set in .env file.');
    process.exit(1);
}

// --- Load Korean Yu Quotes ---
let koreanYuQuotes = [];
let koreanYuQuotesString = ""; // Store quotes as a string for the prompt
const defaultFallbackQuote = "莫忘世上苦人多";
try {
    // Use path relative to server.js location
    const quotesPath = path.join(__dirname, 'quotes.json');
    if (fs.existsSync(quotesPath)) {
        const quotesData = fs.readFileSync(quotesPath, 'utf8'); // Read synchronously at startup
        koreanYuQuotes = JSON.parse(quotesData);
        if (!Array.isArray(koreanYuQuotes) || koreanYuQuotes.length === 0) {
            console.error('Error: quotes.json is empty or not a valid JSON array.');
            koreanYuQuotes = [defaultFallbackQuote]; // Default fallback quote
        } else {
            console.log(`Successfully loaded ${koreanYuQuotes.length} Korean Yu quotes.`);
            // Prepare a string representation for the prompt, limiting length if necessary
            koreanYuQuotesString = koreanYuQuotes.join('\n');
            const maxLength = 1500; // Adjust max length for prompt context as needed
            if (koreanYuQuotesString.length > maxLength) {
               console.warn(`Quotes string length (${koreanYuQuotesString.length}) exceeds ${maxLength} chars, truncating for prompt.`);
               koreanYuQuotesString = koreanYuQuotesString.substring(0, maxLength) + "...";
            }
        }
    } else {
        console.error('Error: quotes.json not found at', quotesPath);
        koreanYuQuotes = [defaultFallbackQuote];
    }
} catch (err) {
    console.error('Error reading or parsing quotes.json:', err);
    koreanYuQuotes = [defaultFallbackQuote]; // Default fallback quote if file is missing or invalid
}
// Ensure quotes string is set even if loading failed
if (!koreanYuQuotesString) {
    koreanYuQuotesString = koreanYuQuotes.join('\n');
}

// Function to get a random quote (defined globally now)
function getRandomQuote() {
    if (koreanYuQuotes.length === 0) {
        return defaultFallbackQuote; // Use the defined default
    }
    const randomIndex = Math.floor(Math.random() * koreanYuQuotes.length);
    return koreanYuQuotes[randomIndex];
}
// --- End Load Korean Yu Quotes ---


// Create LINE SDK client and Express app
const client = new line.Client(lineConfig);
const app = express();

// Initialize Google Generative AI
const genAI = new GoogleGenerativeAI(geminiApiKey);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest"}); // Try gemini-1.5-flash-latest

// Middleware to verify Line signature (place before JSON parsing if possible, or handle raw body)
// Note: line.middleware needs the raw body. Express's json parser consumes it.
// We'll use a workaround to get the raw body for the webhook path.
app.post('/webhook', line.middleware(lineConfig), (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error('Webhook Error:', err);
      res.status(500).end();
    });
});

// Event handler function
async function handleEvent(event) {
  // Ignore non-text messages
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }
  // Allow messages from users, groups, and rooms, but log unknown types
  if (!['user', 'group', 'room'].includes(event.source.type)) {
      console.log(`Ignoring event from unsupported source type: ${event.source.type}`);
      return Promise.resolve(null);
  }

  const messageText = event.message.text.trim();
  let tagToSearch = null;

  // Check for "院長，[tag]" or "院長 [tag]" pattern first
  if (messageText.startsWith('院長，')) {
      tagToSearch = messageText.substring(3).trim(); // Get text after "院長，"
  } else if (messageText.startsWith('院長 ')) {
      tagToSearch = messageText.substring(3).trim(); // Get text after "院長 "
  }

  // Handle specific commands before tag search or general message processing
  if (messageText === '院長好') {
      // Keep the original "院長好" functionality (fetch all photos)
      console.log(`Received "院長好" from source: ${event.source.type}/${event.source.userId || event.source.groupId || event.source.roomId}`);
      try {
          // 1. Fetch ALL photos from your API (no search term)
          console.log(`Fetching all photos from: ${photoApiUrl}`);
          const response = await axios.get(photoApiUrl);
          const photos = response.data;

          if (!photos || photos.length === 0) {
              console.log('No photos found from API for "院長好".');
              // Fallback for "院長好" if no photos
              return client.replyMessage(event.replyToken, {
                  type: 'text',
                  text: `院長這邊現在沒有照片啦！`,
              });
          }
          // Proceed to select random photo from all photos (logic below)
          const randomIndex = Math.floor(Math.random() * photos.length);
          const randomPhoto = photos[randomIndex];
          console.log('Selected random photo for "院長好":', randomPhoto);

          if (!randomPhoto.path || !randomPhoto.path.startsWith('/Photos/')) {
              console.error('Invalid photo path format:', randomPhoto.path);
              return client.replyMessage(event.replyToken, {
                  type: 'text',
                  text: '抱歉，隨機選到的照片路徑格式錯誤。',
              });
          }
          const imageUrl = photoBaseUrl + randomPhoto.path;
          const secureImageUrl = imageUrl.startsWith('https://') ? imageUrl : imageUrl.replace('http://', 'https://');
          console.log(`Replying with image URL: ${secureImageUrl}`);
          return client.replyMessage(event.replyToken, {
              type: 'image',
              originalContentUrl: secureImageUrl,
              previewImageUrl: secureImageUrl,
          });

      } catch (error) {
          console.error('Error processing "院長好" request:', error.message);
          let errorMessage = '抱歉，處理「院長好」請求時發生錯誤。';
          if (error.response) {
              console.error('Photo API Error Status:', error.response.status);
              console.error('Photo API Error Data:', error.response.data);
              errorMessage = '抱歉，無法從圖片庫取得資料。';
          } else if (error.request) {
              console.error('Photo API No Response:', error.request);
              errorMessage = '抱歉，無法連線到圖片庫。';
          }
          return client.replyMessage(event.replyToken, { type: 'text', text: errorMessage });
      }
  } else if (messageText === '院長，金句' || messageText === '院長，語錄') {
      // Handle "金句" or "語錄" command
      console.log(`Received command: "${messageText}" from source: ${event.source.type}/${event.source.userId || event.source.groupId || event.source.roomId}`);
      const randomQuote = getRandomQuote(); // Use the globally defined function
      console.log(`Replying with random quote: "${randomQuote}"`);
      return client.replyMessage(event.replyToken, {
          type: 'text',
          text: randomQuote,
      });
  }

  // If a tag was extracted (and it's not 金句/語錄), search for it
  else if (tagToSearch) { // Changed to else if to avoid re-processing 金句/語錄
    console.log(`Received request for tag: "${tagToSearch}" from source: ${event.source.type}/${event.source.userId || event.source.groupId || event.source.roomId}`);
    try {
      // 1. Fetch photo list from your API using the tag
      const searchApiUrl = `${photoApiUrl}?search=${encodeURIComponent(tagToSearch)}`;
      console.log(`Fetching photos from: ${searchApiUrl}`);
      const response = await axios.get(searchApiUrl);
      const photos = response.data; // API should return filtered photos

      if (!photos || photos.length === 0) {
        // --- Gemini Keyword Search Logic ---
        console.log(`No photos found for tag "${tagToSearch}". Attempting Gemini keyword expansion.`);
        try {
            // 1. Ask Gemini to expand the tag or extract/expand keywords from the sentence
            const prompt = `你是一個關鍵字擴展助手。請分析以下使用者輸入的【搜尋詞彙】。

任務：
1.  判斷【搜尋詞彙】是單一詞彙還是句子。
2.  **如果是單一詞彙**：將其擴展成最多三個語義相近或相關的【繁體中文】詞彙。
3.  **如果是句子**：先提取句子中的核心關鍵字（最多3個），然後將這些核心關鍵字擴展成最多共三個語義相近或相關的【繁體中文】詞彙。
4.  最終目標是產生一個適合用於搜尋圖片標籤的關鍵字列表。

【重要指示】：
1.  **只回傳**用逗號分隔的最終關鍵字列表（最多三個）。
2.  **絕對不要**包含任何說明文字、引號、或其他非關鍵字內容。
3.  **絕對不要**包含「韓國瑜」或任何不當詞彙。
4.  **必須**只使用【繁體中文】和數字。
5.  擴展的詞彙應盡可能具體，適合圖片搜尋。
6.  每個關鍵字長度在1-6個字之間。
7.  避免過於抽象或模糊的詞彙。
8.  避免包含標點符號。
9.  **嚴格限制**：無論如何都不能超過三個關鍵字。

【搜尋詞彙】：
"${tagToSearch}"`;

            let keywords = [];
            try {
                const result = await model.generateContent(prompt);
                const geminiResponse = await result.response;
                const geminiText = geminiResponse.text().trim();

                if (geminiText) {
                    // 改進的關鍵字處理邏輯
                    keywords = geminiText
                        .split(',')
                        .map(k => k.trim())
                        .filter(k => {
                            // 過濾條件：
                            // 1. 不為空
                            // 2. 長度在 1-6 個字之間
                            // 3. 不包含特定關鍵字
                            // 4. 只允許繁體中文和數字
                            if (!k || k.length === 0) return false;
                            if (k.length < 1 || k.length > 6) return false;
                            if (k.includes('韓國瑜')) return false;
                            if (!/^[\u4e00-\u9fa50-9]+$/.test(k)) return false; // 只允許繁體中文和數字
                            return true;
                        })
                        .slice(0, 3); // 確保最多只有三個關鍵字

                    if (keywords.length > 0) {
                        console.log(`Gemini generated and filtered keywords for "${tagToSearch}": "${keywords.join(', ')}"`);
                    } else {
                        console.log(`No valid keywords generated for "${tagToSearch}" after filtering.`);
                    }
                } else {
                    console.log(`Gemini did not return keywords for "${tagToSearch}".`);
                }
            } catch (geminiApiError) {
                console.error(`Error calling Gemini API for tag "${tagToSearch}":`, geminiApiError.message);
                // Proceed with empty keywords, will lead to fallback
            }

            let photoFound = false;
            // 2. Try searching photos using the extracted keywords sequentially
            for (const keyword of keywords) {
                try {
                    const geminiSearchApiUrl = `${photoApiUrl}?search=${encodeURIComponent(keyword)}`;
                    console.log(`Attempting search with Gemini keyword: "${keyword}" from URL: ${geminiSearchApiUrl}`);
                    const photoResponse = await axios.get(geminiSearchApiUrl);
                    const geminiPhotos = photoResponse.data;

                    if (geminiPhotos && geminiPhotos.length > 0) {
                        console.log(`Found ${geminiPhotos.length} photos for Gemini keyword "${keyword}".`);
                        // 3. Select and send a random photo
                        const randomIndex = Math.floor(Math.random() * geminiPhotos.length);
                        const randomPhoto = geminiPhotos[randomIndex];
                        console.log(`Selected random photo for Gemini keyword "${keyword}":`, randomPhoto);

                        if (!randomPhoto.path || !randomPhoto.path.startsWith('/Photos/')) {
                            console.error('Invalid photo path format from Gemini search:', randomPhoto.path);
                            continue; // Try next keyword
                        }

                        const imageUrl = photoBaseUrl + randomPhoto.path;
                        const secureImageUrl = imageUrl.startsWith('https://') ? imageUrl : imageUrl.replace('http://', 'https://');
                        console.log(`Replying with image URL from Gemini search: ${secureImageUrl}`);

                        photoFound = true;
                        // Construct reply messages (check for "罷免" tag again, although unlikely Gemini generates it)
                        const imageMessage = {
                            type: 'image',
                            originalContentUrl: secureImageUrl,
                            previewImageUrl: secureImageUrl,
                        };
                        // Keep original special handling for "罷免" just in case Gemini generates related keywords
                        if (tagToSearch === '罷免') {
                            const textMessage = {
                                type: 'text',
                                text: `人家都說好東西要跟好朋友分享，我體驗過被罷免的感覺，這是一種孤單的感受，就像生日自己吃蛋糕，不好，孤單，寂寞，太邊緣。\n因此，我們要懂得分享，分享被罷免的經驗給同黨的同志，所以各位國人同胞，要讓我們國民黨的立委們，跟我一樣，有著被罷免的美好經驗，請一定要站出來連署，讓我們國民黨的立委們，一起享受被罷免的好滋味！\n\n立刻參與二階段罷免連署！\nhttps://babababa.tw/\n\n最新罷免進度：\nhttps://amaochen0110.github.io/Unseat/`
                            };
                            return client.replyMessage(event.replyToken, [imageMessage, textMessage]);
                        } else {
                            return client.replyMessage(event.replyToken, imageMessage);
                        }
                        // Successfully sent photo, break the loop (already returned)
                    } else {
                        console.log(`No photos found for Gemini keyword "${keyword}".`);
                    }
                } catch (searchError) {
                    console.error(`Error searching photos for Gemini keyword "${keyword}":`, searchError.message);
                    // Continue to the next keyword
                }
            } // End of Gemini keyword loop

            // 4. Fallback if no photo was found after trying all Gemini keywords
            if (!photoFound) {
                console.log(`No photos found for tag "${tagToSearch}" even after Gemini keyword search. Attempting Gemini response generation.`);
                // --- Second Gemini Call: Generate Response based on Tag & Quotes ---
                try {
                    // Construct the prompt asking Gemini to respond ABOUT the tag, using quotes for style
                    const responsePrompt = `你是一個模仿中華民國立法院長韓國瑜的聊天機器人。

請**參考**以下韓國瑜的語錄範例，學習他的**語氣、風格、用詞和邏輯**，然後針對「${tagToSearch}」這個**主題**，**創作**一句全新的、符合韓國瑜風格的回應。

【語錄範例】：
${koreanYuQuotesString}

【使用者提到的主題】：
"${tagToSearch}"

【重要指示】：
1.  你的回應必須是針對「${tagToSearch}」這個**主題**。
2.  你的回應必須**模仿**範例語錄的風格，聽起來像韓國瑜會說的話。
3.  **只回傳**一句話的回應。
4.  **絕對不要**包含任何說明文字、引號或其他非回應內容。
5.  **絕對不要**說**莫非**。`;

                    console.log(`Generating Gemini response about tag "${tagToSearch}" with quotes context.`);
                    const result = await model.generateContent(responsePrompt);
                    const geminiResponse = await result.response;
                    let geminiText = geminiResponse.text().trim();

                    if (geminiText && geminiText.length > 0) {
                        // Removed length check/truncation
                        console.log(`Gemini generated final response for "${tagToSearch}": "${geminiText}"`);
                        // Reply with the Gemini-generated text message
                        return client.replyMessage(event.replyToken, {
                            type: 'text',
                            text: geminiText,
                        });
                    } else {
                        // Gemini returned empty response, treat as failure - Use original fixed fallback
                        console.log(`Gemini returned empty response for tag "${tagToSearch}" during final fallback. Using original fixed message.`);
                        throw new Error("Gemini returned empty response for final fallback");
                    }
                } catch (geminiResponseError) {
                    // Fallback if the *second* Gemini call fails - Use original fixed fallback
                    console.error(`Error during Gemini response generation for tag "${tagToSearch}":`, geminiResponseError.message);
                    console.log(`Falling back to original fixed message for tag "${tagToSearch}" after Gemini response failure.`);
                    return client.replyMessage(event.replyToken, {
                        type: 'text',
                        text: `院長沒有在跟你${tagToSearch}的啦！`, // Original fixed fallback
                    });
                }
                // --- End of Second Gemini Call ---
            } // End of if (!photoFound)

        } catch (geminiSearchError) { // This catch handles errors in the *first* Gemini call (keyword generation) or the keyword search loop itself
            console.error(`Unexpected error during Gemini keyword search process for tag "${tagToSearch}":`, geminiSearchError.message);
            // Fallback to the original fixed message if the initial Gemini keyword process fails
            console.log(`Falling back to original fixed message for tag "${tagToSearch}" after Gemini keyword search process failure.`);
            return client.replyMessage(event.replyToken, {
                type: 'text',
                text: `院長沒有在跟你${tagToSearch}的啦！`, // Original fixed fallback
            });
        }
        // --- End of Gemini Keyword Search Logic ---

      } else {
        // --- Original Photos Found Logic ---
        console.log(`Found ${photos.length} photos for tag "${tagToSearch}".`);
        // 2. Select a random photo from the filtered list
        const randomIndex = Math.floor(Math.random() * photos.length);
        const randomPhoto = photos[randomIndex];
        console.log(`Selected random photo for tag "${tagToSearch}":`, randomPhoto);

        // Ensure the photo object has a 'path' property starting with /Photos/
        if (!randomPhoto.path || !randomPhoto.path.startsWith('/Photos/')) {
            console.error('Invalid photo path format:', randomPhoto.path);
            return client.replyMessage(event.replyToken, {
                type: 'text',
                text: '抱歉，隨機選到的照片路徑格式錯誤。',
            });
        }

        // 3. Construct the full image URL
        const imageUrl = photoBaseUrl + randomPhoto.path;
        const secureImageUrl = imageUrl.startsWith('https://') ? imageUrl : imageUrl.replace('http://', 'https://');

        console.log(`Replying with image URL: ${secureImageUrl}`);

        // 4. Construct reply messages
        const imageMessage = {
          type: 'image',
          originalContentUrl: secureImageUrl,
          previewImageUrl: secureImageUrl,
        };

        // Check if the tag is "罷免" to add the extra text message
        if (tagToSearch === '罷免') {
          const textMessage = {
            type: 'text',
            text: `人家都說好東西要跟好朋友分享，我體驗過被罷免的感覺，這是一種孤單的感受，就像生日自己吃蛋糕，不好，孤單，寂寞，太邊緣。\n因此，我們要懂得分享，分享被罷免的經驗給同黨的同志，所以各位國人同胞，要讓我們國民黨的立委們，跟我一樣，有著被罷免的美好經驗，請一定要站出來連署，讓我們國民黨的立委們，一起享受被罷免的好滋味！\n\n立刻參與二階段罷免連署！\nhttps://babababa.tw/\n\n最新罷免進度：\nhttps://amaochen0110.github.io/Unseat/`
          };
          // Reply with both image and text (up to 5 messages allowed)
          return client.replyMessage(event.replyToken, [imageMessage, textMessage]);
        } else {
          // Reply with only the image for other tags
          return client.replyMessage(event.replyToken, imageMessage);
        }
        // --- End of Original Photos Found Logic ---
      }

    } catch (error) {
      // This catch block now correctly handles errors from the *initial* tag search (axios.get(searchApiUrl))
      console.error(`Error processing tag search request for "${tagToSearch}":`, error.message);
      let errorMessage = `抱歉，搜尋標籤「${tagToSearch}」時發生錯誤。`;
      if (error.response) {
        console.error('Photo API Error Status:', error.response.status);
        console.error('Photo API Error Data:', error.response.data);
        errorMessage = `抱歉，搜尋標籤「${tagToSearch}」時無法從圖片庫取得資料。`;
      } else if (error.request) {
        console.error('Photo API No Response:', error.request);
        errorMessage = `抱歉，搜尋標籤「${tagToSearch}」時無法連線到圖片庫。`;
      }
      // If the initial search fails, we might still want to try Gemini or just fallback?
      // For now, let's keep the original behavior: report the error for the initial search.
      // Consider adding Gemini fallback here too if desired in the future.
      return client.replyMessage(event.replyToken, { type: 'text', text: errorMessage });
    }
  } else {
      // If the message is not "院長好", "院長，金句", "院長，語錄" and doesn't match the tag pattern,
      // handle based on chat type.
      if (event.source.type === 'user') {
          // --- One-on-one chat logic ---
          console.log(`Received text: "${messageText}" from user: ${event.source.userId}.`);
          try {
              // 1. First, try searching using the exact message text as a tag
              const directSearchTag = messageText;
              const directSearchApiUrl = `${photoApiUrl}?search=${encodeURIComponent(directSearchTag)}`;
              console.log(`Attempting direct tag search for "${directSearchTag}" from URL: ${directSearchApiUrl}`);
              let photos = [];
              try {
                  const photoResponse = await axios.get(directSearchApiUrl);
                  photos = photoResponse.data;
              } catch (directSearchError) {
                  console.error(`Error during direct tag search for "${directSearchTag}":`, directSearchError.message);
                  // Don't fail here, proceed to Gemini if direct search API fails
              }

              if (photos && photos.length > 0) {
                  // Found photos with direct tag search
                  console.log(`Found ${photos.length} photos for direct tag "${directSearchTag}".`);
                  const randomIndex = Math.floor(Math.random() * photos.length);
                  const randomPhoto = photos[randomIndex];
                  console.log(`Selected random photo for direct tag "${directSearchTag}":`, randomPhoto);

                  if (!randomPhoto.path || !randomPhoto.path.startsWith('/Photos/')) {
                      console.error('Invalid photo path format from direct search:', randomPhoto.path);
                      // If format is invalid, fall through to Gemini as a backup
                  } else {
                      const imageUrl = photoBaseUrl + randomPhoto.path;
                      const secureImageUrl = imageUrl.startsWith('https://') ? imageUrl : imageUrl.replace('http://', 'https://');
                      console.log(`Replying with image URL from direct search: ${secureImageUrl}`);
                      return client.replyMessage(event.replyToken, {
                          type: 'image',
                          originalContentUrl: secureImageUrl,
                          previewImageUrl: secureImageUrl,
                      });
                  }
              }

              // 2. If direct tag search yields no results or fails gracefully, proceed to Gemini keyword extraction
              console.log(`Direct tag search for "${directSearchTag}" failed or yielded no results. Attempting Gemini keyword extraction.`);
              // Ask Gemini to understand the message, think of a response (like Han Kuo-yu), and extract keywords
              const prompt = `你是一個模仿韓國瑜的聊天機器人。請先理解以下使用者訊息的含義，思考一個直覺上韓國瑜會使用的風格的回應，但不用以高雄市長的角色回覆（不需要輸出回應本身），然後根據你思考的回應，提取最多十個最適合用來搜尋相關圖片的【繁體中文】關鍵字。

【重要指示】：
1.  **只回傳**用逗號分隔的關鍵字列表，例如：「關鍵字1,關鍵字2,關鍵字3,關鍵字4,關鍵字5,關鍵字6,關鍵字7,關鍵字8,關鍵字9,關鍵字10」。
2.  **絕對不要**包含任何說明文字、引號、或其他非關鍵字內容。
3.  **絕對不要**包含「韓國瑜」這個關鍵字。
4.  **必須**只使用【繁體中文】。

使用者訊息：
"${messageText}"`;
              let keywords = [];
              try {
                  const result = await model.generateContent(prompt);
                  const response = await result.response;
                  // Attempt to get only the text part, trim whitespace thoroughly
                  const geminiText = response.text().trim();

                  if (geminiText) {
                      // Parse keywords, assuming they are comma-separated
                      keywords = geminiText.split(',').map(k => k.trim()).filter(k => k);
                      console.log(`Gemini raw response text: "${geminiText}"`);
                      console.log(`Initial parsed keywords: "${keywords.join(', ')}"`);

                      // Explicitly filter out "韓國瑜" and any potentially empty strings again
                      keywords = keywords.filter(keyword => keyword && keyword !== '韓國瑜');
                      console.log(`Keywords after filtering '韓國瑜': "${keywords.join(', ')}"`);

                  } else {
                      console.log('Gemini did not return any keywords.');
                      // Proceed with empty keywords array, will lead to fallback
                  }
              } catch (geminiApiError) {
                  console.error('Error calling Gemini API:', geminiApiError.message);
                  // Proceed with empty keywords array, will lead to fallback
              }

              let photoFound = false;
              // 2. Try searching photos using the extracted keywords sequentially
              for (const keyword of keywords) {
                  try {
                      const searchApiUrl = `${photoApiUrl}?search=${encodeURIComponent(keyword)}`;
                      console.log(`Attempting search with keyword: "${keyword}" from URL: ${searchApiUrl}`);
                      const photoResponse = await axios.get(searchApiUrl);
                      const photos = photoResponse.data;

                      if (photos && photos.length > 0) {
                          console.log(`Found ${photos.length} photos for keyword "${keyword}".`);
                          // 3. Select and send a random photo
                          const randomIndex = Math.floor(Math.random() * photos.length);
                          const randomPhoto = photos[randomIndex];
                          console.log(`Selected random photo for keyword "${keyword}":`, randomPhoto);

                          if (!randomPhoto.path || !randomPhoto.path.startsWith('/Photos/')) {
                              console.error('Invalid photo path format:', randomPhoto.path);
                              // Try next keyword if format is invalid
                              continue;
                          }

                          const imageUrl = photoBaseUrl + randomPhoto.path;
                          const secureImageUrl = imageUrl.startsWith('https://') ? imageUrl : imageUrl.replace('http://', 'https://');
                          console.log(`Replying with image URL: ${secureImageUrl}`);

                          photoFound = true; // Mark as found
                          return client.replyMessage(event.replyToken, {
                              type: 'image',
                              originalContentUrl: secureImageUrl,
                              previewImageUrl: secureImageUrl,
                          });
                          // Successfully sent photo, break the loop (already returned)
                      } else {
                          console.log(`No photos found for keyword "${keyword}".`);
                          // Continue to the next keyword
                      }
                  } catch (searchError) {
                      console.error(`Error searching photos for keyword "${keyword}":`, searchError.message);
                      if (searchError.response) {
                          console.error('Photo API Error Status:', searchError.response.status);
                          console.error('Photo API Error Data:', searchError.response.data);
                      } else if (searchError.request) {
                          console.error('Photo API No Response:', searchError.request);
                      }
                      // Continue to the next keyword even if search fails for one
                  }
              } // End of keyword loop

              // 4. Fallback if no photo was found after trying all keywords - Generate Gemini response based on user message
              if (!photoFound) {
                  console.log('No photos found for any extracted keywords or Gemini failed. Attempting Gemini text response generation based on user message.');
                  try {
                      const responsePrompt = `你是一個模仿中華民國立法院長韓國瑜的聊天機器人。

請**參考**以下韓國瑜的語錄範例，學習他的**語氣、風格、用詞和邏輯**，然後針對以下**使用者訊息**，**創作**一句全新的、符合韓國瑜風格的回應。

【語錄範例】：
${koreanYuQuotesString}

【使用者訊息】：
"${messageText}"

【重要指示】：
1.  你的回應必須針對**使用者訊息**「${messageText}」。
2.  你的回應必須**模仿**範例語錄的風格，聽起來像韓國瑜會說的話。
3.  **只回傳**一句話的回應。
4.  **絕對不要**包含任何說明文字、引號或其他非回應內容。
5.  **絕對不要**說**莫非**。`;

                      console.log("Generating Gemini response for user message with quotes context.");
                      const result = await model.generateContent(responsePrompt);
                      const geminiResponse = await result.response;
                      let geminiText = geminiResponse.text().trim();

                      if (geminiText && geminiText.length > 0) {
                          // Removed length check/truncation
                          console.log(`Gemini generated final response for user message "${messageText}": "${geminiText}"`);
                          return client.replyMessage(event.replyToken, {
                              type: 'text',
                              text: geminiText,
                          });
                      } else {
                          console.log(`Gemini returned empty response for user message "${messageText}". Falling back to fixed default message.`);
                          throw new Error("Gemini returned empty response for user message fallback");
                      }
                  } catch (geminiResponseError) {
                      console.error(`Error during Gemini response generation for user message "${messageText}":`, geminiResponseError.message);
                      console.log(`Falling back to fixed default message for user message "${messageText}" after Gemini response failure.`);
                      // Use the fallback message incorporating the original user message
                      return client.replyMessage(event.replyToken, {
                          type: 'text',
                          text: `院長沒有在跟你${messageText}的啦！`,
                      });
                  }
              }

          } catch (error) // Catch any unexpected errors in the outer try block
          {
              console.error('Unexpected error during user message processing:', error.message);
              // Fallback to the message incorporating the original user message for any other unexpected error
              console.log('Falling back to user-message-based fixed message due to unexpected error.');
              return client.replyMessage(event.replyToken, {
                  type: 'text',
                  text: `院長沒有在跟你${messageText}的啦！`,
              });
          }
      } else {
          // If it's a group or room, do nothing for unmatched text
          console.log(`Unmatched text: "${messageText}" from source: ${event.source.type}/${event.source.groupId || event.source.roomId}. Ignoring.`);
          return Promise.resolve(null);
      }
  }
}

// Start the server
const port = process.env.PORT || 3001; // Fly.io sets the PORT env var
const host = '0.0.0.0'; // Listen on all available network interfaces

app.listen(port, host, () => {
  console.log(`Line Bot server listening on ${host}:${port}`);
  console.log('Make sure to set the Webhook URL in Line Developers Console to: https://han-office-linebot.zeabur.app/webhook');
});
