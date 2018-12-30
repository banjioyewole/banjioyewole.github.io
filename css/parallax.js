$(window).scroll(function() {
  parallax();
})

function parallax() {

  var wScroll = $(window).scrollTop()


  $('.parallax--bg').css('background-position', 'center ' + (wScroll*0.75)+'px');


  // $('.parallax--box').css('margin-top',  ( $(window).height()*.95+ -(wScroll*.5))+'px')

elem = $('.video_box')

  elem.css('padding-top',  ( ($(window).height()*.25) -  (wScroll*.1))+'px')

// console.log($('.parallax--box').scrollTop());

  $('.container_one').css('margin-top',  ( ($(window).height() - $('.container_one').height())/.5)  + 'px')
  $('.video_box').css('margin-top',  ( ($(window).height() - $('.video_box').height())/.5)  + 'px')


  // console.log(wScroll)

}
